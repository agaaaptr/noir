import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createProjectId, type ManagedBlock, paths, readManagedBlock } from '@noir-ai/core';
import { readAncestors, writeAncestors } from './ancestors.js';
import {
  type BuildManifestContext,
  buildManifest,
  type HostTag,
  type ManifestEntry,
} from './manifest.js';
import { mergeThreeWay } from './merge.js';
import { runMigrations } from './migrations/index.js';
import {
  CURRENT_SCAFFOLD_VERSION,
  readScaffoldVersion,
  writeScaffoldVersion,
} from './scaffold-version.js';
import { detectStack, type StackInfo } from './stack-detect.js';
import { render } from './template.js';
import { loadTemplate } from './template-loader.js';
import {
  buildRegion,
  managedBlock,
  managedBlocks,
  regenerate,
  skipIfExists,
  type WriteMode,
} from './writers.js';

/**
 * Scaffold orchestrator. One function the cli (S-T2) calls for `noir init`,
 * `noir create`, and `noir sync`; mode selects the manifest subset + how
 * project identity is resolved.
 *
 * High-level flow:
 *  1. Resolve project id (provided > existing > generated; sync requires existing).
 *  2. Detect stack (READ-ONLY; always runs; never throws).
 *  3. If {@link ScaffoldOptions.upgrade}, run migrations from the on-disk
 *     scaffold-version → {@link CURRENT_SCAFFOLD_VERSION}.
 *  4. Build the manifest, filter by host + mode.
 *  5. For each entry: mkdir -p, render template/content, dispatch to the
 *     matching writer.
 *  6. On `init`/`create`, stamp `.noir/scaffold-version` LAST so a crash leaves
 *     an old/absent stamp rather than a misleading fresh one.
 *
 * The orchestrator owns dir creation (writers refuse to so that a missing dir
 * is one attributable failure, not N silent ones).
 */

export type ScaffoldMode = 'init' | 'create' | 'sync';

export interface ScaffoldOptions {
  /** Absolute repo root. For `create`, the new dir (created if absent). */
  root: string;
  mode: ScaffoldMode;
  /** Target host. Defaults to `'claude'` (the only shipped host). */
  host?: HostTag;
  /** MCP transport. Defaults to `'stdio'`. */
  transport?: 'stdio' | 'streamable-http';
  /** Required when transport is `streamable-http`. */
  url?: string;
  /** Explicit project id; bypasses generate/read. Mainly for tests + `create`
   *  flows that want deterministic ids. */
  projectId?: string;
  /** `noir init --upgrade`: run migrations before re-emitting, and emit only
   *    regenerate + managedBlock (skipIfExists left alone). Only meaningful
   *    with mode `'init'`. */
  upgrade?: boolean;
  /** SP-A: re-scaffold even when the target is already initialized (bypasses
   *    the already-initialized no-op guard). Does NOT bypass `assertSafeRoot`
   *    — root-safety is hard, never bypassable. */
  force?: boolean;
  /** Preview: compute the same written/skipped/migrated lists without touching
   *    disk. `noir doctor`/CI use this to report drift. */
  dryRun?: boolean;
  /** SP-C: policy for a `regenerate` file that exists and DIFFERS from the
   *    template, when no {@link onConflict} callback is provided. Default
   *    `'overwrite'` is byte-backward-compatible. `'preserve'` keeps the user's
   *    file (the non-TTY / CI default in the cli). */
  conflictPolicy?: 'overwrite' | 'preserve';
  /** SP-C: per-file conflict resolver — the UI seam (the engine stays UI-free;
   *    the cli injects a @clack-based resolver). Called when a `regenerate`
   *    file exists and differs from the template. */
  onConflict?: (ctx: ConflictContext) => Promise<ConflictResolution> | ConflictResolution;
  /** SP-D follow-up: three-way merge managed regions (base/ours/theirs) using a
   *  persisted ancestor snapshot (`.noir/ancestors.json`) instead of
   *  strip-replace, so a hand-edit inside a `<!-- noir:* -->` region survives a
   *  template update. Opt-in (default false ⇒ current strip-replace, no
   *  ancestor file). Single-region managed files only (NOIR.md, ignores);
   *  multi-region (CLAUDE.md) is a follow-up. */
  mergeManagedRegions?: boolean;
}

export interface ScaffoldResult {
  /** Repo-relative paths actually written. */
  written: string[];
  /** Repo-relative paths skipIfExists'd (already present). */
  skipped: string[];
  /** SP-D: repo-relative `regenerate` paths skipped because byte-identical to
   *  the template (content-hash dedup — no rewrite). */
  identical: string[];
  /** SP-A: true when the already-initialized guard short-circuited (a bare
   *  `noir init`/`create` on an initialized project). Callers (init.ts/create.ts)
   *  gate skills emission + the "initialized" message on this — a no-op must NOT
   *  re-emit skills or claim it initialized. */
  noop: boolean;
  /** Migration steps executed (`<from>→<to>`), when upgrade ran. */
  migrationsRan: string[];
  /** Migration conflicts (repo-relative or `<runner>:…`), when upgrade ran. */
  migrationConflicts: string[];
  stack: StackInfo;
  projectId: string;
  fromVersion: string | null;
  toVersion: string;
  /** The host actually emitted (post-default). */
  host: HostTag;
}

/** SP-C — context passed to {@link ScaffoldOptions.onConflict} when a
 *  `regenerate` file exists and differs from the template. */
export interface ConflictContext {
  /** Repo-relative path of the conflicting file. */
  relPath: string;
  /** The file's current on-disk content. */
  existing: string;
  /** The content the scaffold would write. */
  proposed: string;
}

/** SP-C — how to resolve a `regenerate` conflict. */
export type ConflictResolution = 'replace' | 'preserve' | 'rename' | 'duplicate' | 'cancel';

const WRITER_BY_MODE: Record<WriteMode, 'all' | 'runtime'> = {
  // 'runtime' subset = regenerate + managedBlock (the always-safe-to-rewrite
  // entries). sync + init --upgrade emit only this subset; skipIfExists is
  // reserved for first-run init/create so user edits survive.
  regenerate: 'runtime',
  managedBlock: 'runtime',
  skipIfExists: 'all',
};

/**
 * Refuse to scaffold when `root` is — or is inside — a `.noir/` directory.
 * (SP-A) Running `noir init`/`create`/`sync` while cwd = `.noir/` would
 * otherwise mint a FRESH project id (because `<root>/.noir/project.id` is
 * absent) and build a NESTED second project (`.noir/.noir/`, `.noir/CLAUDE.md`,
 * `.noir/.claude/skills/`, …) — the duplicate-`.noir` bug. The walk ascends the
 * ancestor chain only, so a legitimate project root that merely CONTAINS a
 * `.noir/` store is never flagged. String-based: works whether or not `root`
 * exists on disk yet (so `noir create <new-dir>` is still guarded).
 *
 * Hard against literal `.noir` path segments — NOT bypassable by `--force`
 * (which is reserved for the already-initialized no-op). NOTE: the walk is
 * string-based, so a symlink whose TARGET is inside `.noir/` is not resolved
 * (a local self-foot-gun only — the caller controls `root` — not externally
 * exploitable); in practice `--cwd`/positional roots are literal paths.
 */
export function assertSafeRoot(root: string): void {
  let cur = root;
  for (let i = 0; i < 64; i++) {
    if (basename(cur) === '.noir') {
      throw new Error(
        `Refusing to scaffold inside a .noir/ directory (${root}). Run \`noir init\` from the project root, not from inside .noir/.`,
      );
    }
    const parent = dirname(cur);
    if (parent === cur) break; // reached the filesystem root
    cur = parent;
  }
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  // Root-safety (SP-A): refuse to scaffold at/inside a .noir/ directory BEFORE
  // any write (incl. `create`'s target mkdir). Prevents the nested .noir/.noir/
  // re-init bug. Hard guard; not bypassable.
  assertSafeRoot(opts.root);

  const host: HostTag = opts.host ?? 'claude';
  const transport: BuildManifestContext['transport'] = opts.transport ?? 'stdio';
  if (transport === 'streamable-http' && !opts.url) {
    throw new Error("transport 'streamable-http' requires opts.url");
  }

  // 1. Root for `create` may not exist yet — mirror `init.ts`'s mkdir of .noir/.
  if (opts.mode === 'create' && !opts.dryRun) {
    mkdirSync(opts.root, { recursive: true });
  }

  // 2. Resolve project id. Read the on-disk stamp ONCE and reuse the result
  //    for the corrupt-file heal below (C1). sync requires a VALID existing id.
  const idFile = readProjectIdFile(opts.root);
  const projectId = resolveProjectId(opts, idFile);

  // C1: a `project.id` that EXISTS but is empty/unparseable is CORRUPT, not
  // absent. The manifest writes project.id via `skipIfExists`, which would
  // preserve the empty file while NOIR.md's BRIEF_BLOCK renders the freshly
  // resolved/generated id → silent identity split (NOIR.md states an id the
  // store DB can't open). project.id is Noir-owned canonical; heal a corrupt
  // stamp by removing it so `skipIfExists` writes the resolved id fresh.
  // Absent/valid files and dryRun are left to the manifest writer.
  if (!opts.dryRun && idFile.state === 'corrupt') {
    rmSync(paths.projectId(opts.root), { force: true });
  }

  const fromVersion = readScaffoldVersion(opts.root);

  // 3. Stack detect (read-only, never throws). Always populated so callers
  //    (TUI, doctor) get a single source of truth regardless of mode.
  const stack = detectStack(opts.root);

  // SP-D: ancestor map for three-way managed-region merge (opt-in). Read once;
  // written back at the end only when mergeManagedRegions is set.
  const ancestors = opts.mergeManagedRegions ? readAncestors(opts.root) : {};

  // SP-A — already-initialized guard: a bare `noir init`/`noir create` on a
  // project that already carries a .noir/scaffold-version stamp is a NO-OP,
  // not a silent re-emit (re-running init looked like it re-scaffolded, which
  // is what made the nested-`.noir` bug feel like "init duplicates things").
  // `--upgrade` is the explicit migrate+re-emit path; `--force` re-scaffolds
  // without migrating. Both bypass this guard. sync is unaffected (it requires
  // a valid project.id and emits the runtime subset only). dryRun returns the
  // no-op shape silently (no stderr) so `noir doctor`/CI previews stay clean.
  if (
    fromVersion !== null &&
    opts.upgrade !== true &&
    opts.force !== true &&
    (opts.mode === 'init' || opts.mode === 'create')
  ) {
    if (opts.dryRun !== true) {
      process.stderr.write(
        `Noir is already initialized in ${opts.root} (scaffold ${fromVersion}). No-op. Use \`noir init --upgrade\` to migrate, or \`--force\` to re-scaffold.\n`,
      );
    }
    return {
      written: [],
      skipped: [],
      identical: [],
      noop: true,
      migrationsRan: [],
      migrationConflicts: [],
      stack,
      projectId,
      fromVersion,
      toVersion: CURRENT_SCAFFOLD_VERSION,
      host,
    };
  }

  // 4. Migrations (only when explicitly upgrading). M4: a fresh project
  //    (`fromVersion === null`) has NO prior stamp → nothing to migrate. Skip
  //    entirely so `noir init --upgrade` on a never-initialized tree doesn't
  //    report a synthetic no-op `1.0.0→1.0.0` step.
  const migrationsRan: string[] = [];
  const migrationConflicts: string[] = [];
  if (opts.mode === 'init' && opts.upgrade === true && fromVersion !== null) {
    const m = runMigrations(opts.root, fromVersion, CURRENT_SCAFFOLD_VERSION, {
      dryRun: opts.dryRun === true,
    });
    migrationsRan.push(...m.ran);
    migrationConflicts.push(...m.conflicts);
  }

  // 5. Build manifest + filter by host + mode.
  const manifest = buildManifest({
    root: opts.root,
    projectId,
    host,
    transport,
    url: opts.url,
    stack,
  });
  const emitRuntimeOnly = opts.mode === 'sync' || (opts.mode === 'init' && opts.upgrade === true);
  const vars: BuildManifestContext = {
    root: opts.root,
    projectId,
    host,
    transport,
    url: opts.url,
  };

  const written: string[] = [];
  const skipped: string[] = [];
  const identical: string[] = [];

  // GROUP applicable entries by target path (manifest order preserved within
  // each group) so files carrying MULTIPLE managed blocks (CLAUDE.md today =
  // CONTEXT + RULES) get ONE atomic multi-region write (I1). Single-entry
  // paths keep the existing per-entry writer — byte-stable for the NOIR.md
  // brief, the ignore files, and the regenerated `.mcp.json`. dryRun uses the
  // SAME grouping so its reported paths match what a real run would write
  // (CLAUDE.md reported once, not twice).
  const groups = groupApplicableByPath(manifest, host, emitRuntimeOnly);
  for (const [relPath, entries] of groups) {
    const abs = join(opts.root, relPath);
    const managed = entries.filter((e) => e.mode === 'managedBlock');

    if (managed.length >= 2) {
      // Multi-managed-block file: ONE atomic write of all regions.
      if (opts.dryRun) {
        written.push(relPath);
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      const regions = managed.map((e) => {
        const block = e.block;
        if (!block) {
          throw new Error(`manifest entry ${e.path}: managedBlock mode missing 'block'`);
        }
        const theirs = buildRegion(block, renderEntry(e, vars));
        const regionText = opts.mergeManagedRegions
          ? mergeManagedRegion(abs, e.path, block, theirs, ancestors)
          : theirs;
        if (opts.mergeManagedRegions) ancestors[`${e.path}::${block.begin}`] = theirs;
        return { block, regionText };
      });
      managedBlocks(abs, regions);
      written.push(relPath);
      continue;
    }

    // Per-entry path: single-region managed / regenerate / skipIfExists.
    if (!opts.dryRun) mkdirSync(dirname(abs), { recursive: true });
    for (const entry of entries) {
      if (opts.dryRun) {
        if (entry.mode === 'skipIfExists' && existsSync(abs)) skipped.push(entry.path);
        else written.push(entry.path);
        continue;
      }
      const body = renderEntry(entry, vars);
      if (entry.mode === 'regenerate') {
        const out = await writeRegenerateWithConflict(abs, entry.path, body, opts);
        written.push(...out.written);
        skipped.push(...out.skipped);
        identical.push(...out.identical);
      } else if (entry.mode === 'managedBlock') {
        const block = entry.block;
        if (!block) {
          throw new Error(`manifest entry ${entry.path}: managedBlock mode missing 'block'`);
        }
        // I2: a legacy (pre-Slice-S) .noir/NOIR.md is a whole-file auto-brief
        // with NO managed markers. The normal path would treat the old brief
        // as user content and append a SECOND managed brief → two "Project
        // id:" lines. Self-heal: when the existing file has NO noir managed
        // marker at all, wipe it first so the managed write emits a clean
        // single brief. (Pre-Slice-S NOIR.md was 100% auto-generated, so
        // there is no user content to preserve in that legacy shape.)
        if (isNoirMdPath(entry.path)) healLegacyNoirMd(abs);
        const theirs = buildRegion(block, body);
        const regionText = opts.mergeManagedRegions
          ? mergeManagedRegion(abs, entry.path, block, theirs, ancestors)
          : theirs;
        managedBlock(abs, block, regionText);
        if (opts.mergeManagedRegions) ancestors[`${entry.path}::${block.begin}`] = theirs;
        written.push(entry.path);
      } else {
        const out = skipIfExists(abs, body);
        if (out.written) written.push(entry.path);
        else skipped.push(entry.path);
      }
    }
  }

  // 6. Stamp scaffold-version on init/create (NOT sync). Written last so a
  //    crash leaves the previous stamp. Upgrade rewrites it to current.
  if ((opts.mode === 'init' || opts.mode === 'create') && !opts.dryRun) {
    writeScaffoldVersion(opts.root, CURRENT_SCAFFOLD_VERSION);
  }

  // SP-D: persist the ancestor map (only when three-way merge is opted in).
  if (opts.mergeManagedRegions && !opts.dryRun) {
    writeAncestors(opts.root, ancestors);
  }

  return {
    written,
    skipped,
    identical,
    noop: false,
    migrationsRan,
    migrationConflicts,
    stack,
    projectId,
    fromVersion,
    toVersion: CURRENT_SCAFFOLD_VERSION,
    host,
  };
}

// --- helpers -----------------------------------------------------------------

/** SP-D — three-way merge a managed region against the persisted ancestor
 *  (`base`). `theirs` is the freshly-rendered template region (with markers);
 *  `ours` is the region currently on disk. With no ancestor / no existing
 *  region this is a no-op (returns `theirs`). On conflict, inline markers are
 *  written + a stderr note (never silently drops either side). */
function mergeManagedRegion(
  abs: string,
  relPath: string,
  block: ManagedBlock,
  theirs: string,
  ancestors: Record<string, string>,
): string {
  const base = ancestors[`${relPath}::${block.begin}`];
  if (base === undefined) return theirs; // no ancestor yet → strip-replace (first merge run)
  const ours = readManagedBlock(abs, block);
  if (ours === null) return theirs; // no existing region → fresh
  const res = mergeThreeWay(base, ours, theirs);
  if (res.conflict) {
    process.stderr.write(
      `noir: managed-region conflict in ${relPath} — wrote inline markers; resolve manually.\n`,
    );
  }
  return res.merged;
}

/** Read the `.noir/project.id` stamp ONCE and classify it for BOTH id
 *  resolution and the C1 corrupt-file heal. `absent` (ENOENT) and `valid`
 *  (non-empty) are the normal cases; `corrupt` (file exists but trims to empty)
 *  is healed by the orchestrator before the manifest loop so `skipIfExists`
 *  writes the resolved id fresh instead of preserving the empty file. */
function readProjectIdFile(
  root: string,
): { state: 'absent'; id: null } | { state: 'valid'; id: string } | { state: 'corrupt'; id: null } {
  let raw: string;
  try {
    raw = readFileSync(paths.projectId(root), 'utf8');
  } catch {
    return { state: 'absent', id: null };
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? { state: 'valid', id: trimmed } : { state: 'corrupt', id: null };
}

function resolveProjectId(
  opts: ScaffoldOptions,
  idFile: ReturnType<typeof readProjectIdFile>,
): string {
  if (opts.projectId !== undefined) return opts.projectId;
  if (idFile.state === 'valid') return idFile.id;
  // absent OR corrupt → resolve a fresh id. sync still requires a valid
  // pre-existing id (a corrupt stamp can't be trusted to name the store DB).
  if (opts.mode === 'sync') {
    throw new Error(`Noir is not initialized in ${opts.root}. Run \`noir init\` first.`);
  }
  return createProjectId();
}

/**
 * SP-C — write a `regenerate` file, honoring conflict resolution when the
 * target already exists and DIFFERS from the proposed bytes. Identical bytes
 * (or a missing file) write straight through (content-hash dedup is a deferred
 * slice — identical still "writes" today to keep sync/--upgrade byte-stable).
 * Resolution:
 *  - `replace`         — overwrite (the historical default).
 *  - `preserve`/`cancel` — keep the user's file; report skipped.
 *  - `rename`          — move the user's file to `<path>.local`, write template.
 *  - `duplicate`       — write the template to `<path>.noir`, keep the user's.
 * Returns the repo-relative paths to record as written / skipped.
 */
async function writeRegenerateWithConflict(
  abs: string,
  relPath: string,
  proposed: string,
  opts: ScaffoldOptions,
): Promise<{ written: string[]; skipped: string[]; identical: string[] }> {
  let existing: string | undefined;
  try {
    existing = readFileSync(abs, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing === undefined) {
    regenerate(abs, proposed);
    return { written: [relPath], skipped: [], identical: [] };
  }
  if (existing === proposed) {
    // content-hash dedup: byte-identical → skip the rewrite entirely (no disk IO).
    return { written: [], skipped: [], identical: [relPath] };
  }
  const resolution: ConflictResolution =
    opts.onConflict !== undefined
      ? await opts.onConflict({ relPath, existing, proposed })
      : opts.conflictPolicy === 'preserve'
        ? 'preserve'
        : 'replace';
  switch (resolution) {
    case 'replace':
      regenerate(abs, proposed);
      return { written: [relPath], skipped: [], identical: [] };
    case 'rename': {
      // Preserve the user's file aside at a UNIQUE path. Review fix: a bare
      // `renameSync(abs, abs.local)` would silently clobber a pre-existing
      // `.local` (POSIX rename replaces) or throw EEXIST mid-scaffold (win32) —
      // the very data-loss SP-C exists to prevent. uniqueAside picks a fresh
      // `.local` (then `.local.1`, …) so the move is always safe.
      const aside = uniqueAside(abs, relPath, '.local');
      renameSync(abs, aside.abs);
      regenerate(abs, proposed);
      return { written: [relPath], skipped: [aside.rel], identical: [] };
    }
    case 'duplicate': {
      // Write the template ALONGSIDE at a unique path; keep the user's file
      // untouched. (Same unique-suffix safeguard as `rename`.)
      const aside = uniqueAside(abs, relPath, '.noir');
      regenerate(aside.abs, proposed);
      return { written: [aside.rel], skipped: [relPath], identical: [] };
    }
    case 'preserve':
      return { written: [], skipped: [relPath], identical: [] };
    case 'cancel':
      // Review fix: Cancel ABORTS the whole scaffold. It used to fall through
      // to "skip this file" and keep writing the remaining entries — a contract
      // violation (Cancel/Escape must stop the run). Throwing propagates out of
      // scaffold(); the cli reports it. Entries written before this conflict
      // remain on disk, as with any cancelled operation.
      throw new Error(`scaffold cancelled by user at conflicting file ${relPath}`);
    default:
      return { written: [], skipped: [relPath], identical: [] };
  }
}

/** Pick a fresh `<abs><suffix>` aside path (plus its repo-relative form) that
 *  does NOT exist: tries `<suffix>`, then `<suffix>.1`, `<suffix>.2`, … so the
 *  `rename`/`duplicate` resolutions never silently overwrite a prior backup
 *  (data-loss) and never hit win32 EEXIST. */
function uniqueAside(abs: string, relPath: string, suffix: string): { abs: string; rel: string } {
  const make = (s: string): { abs: string; rel: string } => ({
    abs: `${abs}${s}`,
    rel: `${relPath}${s}`,
  });
  let candidate = make(suffix);
  for (let n = 1; existsSync(candidate.abs); n++) candidate = make(`${suffix}.${n}`);
  return candidate;
}

/** Group applicable manifest entries by target path, preserving manifest order
 *  within each group. JS `Map` preserves insertion order, so iterating groups
 *  visits paths in the same sequence the manifest declares them (CONTEXT before
 *  RULES inside the CLAUDE.md group). */
function groupApplicableByPath(
  manifest: readonly ManifestEntry[],
  host: HostTag,
  emitRuntimeOnly: boolean,
): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of manifest) {
    if (entry.host !== undefined && entry.host !== host) continue; // host filter
    if (emitRuntimeOnly && WRITER_BY_MODE[entry.mode] !== 'runtime') continue;
    const list = groups.get(entry.path);
    if (list) list.push(entry);
    else groups.set(entry.path, [entry]);
  }
  return groups;
}

/** True for the canonical NOIR.md path the manifest emits (the BRIEF_BLOCK
 *  target). Scoped so the I2 legacy-heal only fires for that one file — we must
 *  not wipe arbitrary co-owned managed files. */
function isNoirMdPath(relPath: string): boolean {
  return relPath === '.noir/NOIR.md';
}

/** I2 self-heal: wipe a legacy (pre-Slice-S) NOIR.md before the managed write.
 *  Legacy shape = file exists but contains NO `<!-- noir:<name> begin -->`
 *  managed marker (the whole file was the auto-brief). Files that already have
 *  markers, or are absent, are left untouched (normal managed-block path or
 *  fresh write respectively). */
function healLegacyNoirMd(absPath: string): void {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return; // absent — fresh write, nothing to heal
  }
  if (/<!-- noir:[a-z]+ begin -->/.test(content)) return; // already managed-shape
  rmSync(absPath, { force: true });
}

function renderEntry(entry: ManifestEntry, vars: BuildManifestContext): string {
  if (entry.template !== undefined) {
    return render(loadTemplate(entry.template), vars);
  }
  if (entry.content !== undefined) return entry.content;
  throw new Error(`manifest entry ${entry.path}: must define 'content' or 'template'`);
}
