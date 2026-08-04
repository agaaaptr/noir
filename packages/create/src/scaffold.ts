import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  createProjectId,
  type ManagedBlock,
  paths,
  readManagedBlock,
  resolveNoirCommand,
} from '@noir-ai/core';
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
  predictManagedBlock,
  predictManagedBlocks,
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
   *    file exists and differs from the template. The return type widens to
   *    accept a rich shape carrying `applyToAll` — the engine then reuses the
   *    decision for the rest of the run (per artifact CLASS). */
  onConflict?: (ctx: ConflictContext) => Promise<ConflictResolverReturn> | ConflictResolverReturn;
  /** Three-way merge managed regions (base/ours/theirs) using a persisted
   *  ancestor snapshot (`.noir/ancestors.json`) instead of strip-replace, so a
   *  hand-edit inside a `<!-- noir:* -->` region survives a template update.
   *  DEFAULT TRUE: ancestor capture is unconditional, so the first merge
   *  run always has a base. Set to `false` (CLI `--no-merge-regions`) to
   *  restore strip-replace. Supports BOTH single-region (NOIR.md, ignores) AND
   *  multi-region (CLAUDE.md CONTEXT+RULES) managed files — the multi-region
   *  path shipped with SP-H (`managedBlocks` + `mergeManagedRegion` per block). */
  mergeManagedRegions?: boolean;
  /** Explicit interactivity signal. The engine reads THIS (not
   *  `process.env`), so a direct API/embedded caller in a TTY that does NOT
   *  inject {@link onConflict} never hits a @clack prompt. The CLI sets it from
   *  its global flags (via the `NOIR_NON_INTERACTIVE` bridge bin.ts owns);
   *  `process.env` remains only a fallback bridge for the CLI layer. */
  interactive?: boolean;
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
  /** Structured conflict report — one record per file that existed AND
   *  differed from the proposed bytes (regenerate conflict path). Populated in
   *  `--json`/`--no-input`/non-TTY runs (no prompt fires) so a CI/JSON caller
   *  can see exactly which files diverged + how they were resolved, without
   *  grepping stderr. Empty when no conflicts occurred (also on first-run +
   *  no-op). */
  conflicts: ConflictRecord[];
}

/** One entry in {@link ScaffoldResult.conflicts}. */
export interface ConflictRecord {
  /** Repo-relative path of the conflicting file. */
  path: string;
  /** Artifact class — drives apply-to-all memory scope + report grouping. */
  mode: ConflictContext['mode'];
  /** LCS similarity (0-1) between existing and proposed. */
  similarity?: number;
  /** sha256 (hex, first 12 chars) of the on-disk bytes at conflict time. */
  existingSha: string;
  /** sha256 (hex, first 12 chars) of the proposed bytes. */
  proposedSha: string;
  /** Resolution the engine applied (`replace`/`preserve`/`rename`/…). */
  resolution: ConflictResolution;
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
  /** Artifact class — drives apply-to-all memory scope (`regenerate` shares
   *  one decision across a run; `managedBlock`/`managedBlocks` stay per-file).
   *  Defaults to `'regenerate'` for backward compatibility with SP-C resolvers
   *  that pre-date the field (the engine always sets it). */
  mode?:
    | 'regenerate'
    | 'managedBlock'
    | 'managedBlocks'
    | 'skipIfExists'
    | 'skill'
    | 'markdown'
    | 'artifact';
  /** LCS similarity (0-1) between existing and proposed. Cheap signal for
   *  the resolver to bias toward `replace` when ~1.0 or `preserve` when ~0. */
  similarity?: number;
  /** When the 3-way merge of a managed region hit an overlap, the merged
   *  bytes WITH zdiff3 conflict markers (selecting `'merge'` writes this). */
  mergedWithMarkers?: string;
}

/** SP-C — how to resolve a `regenerate` conflict. */
export type ConflictResolution =
  | 'replace'
  | 'preserve'
  | 'rename'
  | 'duplicate'
  | 'cancel'
  | 'merge';

/** The resolver may return a bare {@link ConflictResolution} (scope
 *  `'one'`) OR a rich shape carrying `applyToAll`. The engine unwraps both; when
 *  `applyToAll` is true it stores the choice in its per-run memory keyed by
 *  artifact CLASS (`regenerate` shares one decision across a run; managedBlock
 *  stays per-file regardless — user edits there need individual review). */
export type ConflictResolverReturn =
  | ConflictResolution
  | { resolution: ConflictResolution; applyToAll?: boolean };

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
  //    for the corrupt-file heal below. sync requires a VALID existing id.
  const idFile = readProjectIdFile(opts.root);
  const projectId = resolveProjectId(opts, idFile);

  // A `project.id` that EXISTS but is empty/unparseable is CORRUPT, not
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

  // Ancestor snapshot is read + captured UNCONDITIONALLY (not just under
  // --merge) so the first merge run — now the DEFAULT — always has a base. The
  // merge APPLICATION still keys off `mergeManagedRegions` below; ancestor
  // CAPTURE is always-on. `writeAncestors` at the end dedups internally.
  const ancestors = readAncestors(opts.root);
  // mergeManagedRegions defaults to TRUE. `--no-merge-regions`
  // (CLI) restores strip-replace by setting opts.mergeManagedRegions = false.
  const mergeManagedRegions = opts.mergeManagedRegions !== false;

  // Widened no-op guard (was: scaffold-version present ONLY). A bare
  // `noir init`/`noir create` is a NO-OP when the project carries EITHER a
  // `.noir/scaffold-version` stamp (1.3.0+) OR a `.noir/project.id` (pre-1.3.0
  // legacy). Previously a legacy project (id present, no stamp) re-scaffolded
  // on every bare init; now it no-ops too. `--upgrade` stays the explicit
  // migration entry (M4 skips synthetic migrations when fromVersion === null);
  // `--force` re-scaffolds without migrating. Both bypass this guard. sync is
  // unaffected (it requires a valid project.id and emits the runtime subset).
  // dryRun returns the no-op shape silently so `noir doctor`/CI previews stay
  // clean.
  const hasIdentity = fromVersion !== null || idFile.state === 'valid';
  if (
    hasIdentity &&
    opts.upgrade !== true &&
    opts.force !== true &&
    (opts.mode === 'init' || opts.mode === 'create')
  ) {
    if (opts.dryRun !== true) {
      const where =
        fromVersion !== null
          ? `at scaffold ${fromVersion}`
          : '(pre-1.3.0 project; no scaffold-version stamp)';
      process.stderr.write(
        `Noir already initialized in ${opts.root} ${where}; run \`noir init --upgrade\` to migrate.\n`,
      );
    }
    return {
      written: [],
      skipped: [],
      identical: [],
      conflicts: [],
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
  // Resolve the MCP `command`: the absolute native shim when a native install
  // is detected (GUI MCP clients don't read shell profiles → `spawn noir
  // ENOENT`), else `'noir'`. Read-only + never throws; defaults to 'noir'.
  const command = resolveNoirCommand();
  const manifest = buildManifest({
    root: opts.root,
    projectId,
    host,
    transport,
    url: opts.url,
    command,
    stack,
  });
  const emitRuntimeOnly = opts.mode === 'sync' || (opts.mode === 'init' && opts.upgrade === true);
  const vars: BuildManifestContext = {
    root: opts.root,
    projectId,
    host,
    transport,
    url: opts.url,
    command,
  };

  const written: string[] = [];
  const skipped: string[] = [];
  const identical: string[] = [];
  // Per-run conflict memory + structured report. Memory is keyed by
  // artifact CLASS for `regenerate` (one decision shared across the run, so a
  // `noir init --upgrade` over N pointers → 1 prompt) and by per-file path for
  // `managedBlock`/`managedBlocks` (user edits there need individual review).
  const conflictMemory = new Map<string, ConflictResolution>();
  const conflictRecords: ConflictRecord[] = [];
  const recordConflict = (
    relPath: string,
    mode: NonNullable<ConflictContext['mode']>,
    existing: string,
    proposed: string,
    resolution: ConflictResolution,
    similarity?: number,
  ): void => {
    conflictRecords.push({
      path: relPath,
      mode,
      similarity,
      existingSha: sha256Hex12(existing),
      proposedSha: sha256Hex12(proposed),
      resolution,
    });
  };

  // GROUP applicable entries by target path (manifest order preserved within
  // each group) so files carrying MULTIPLE managed blocks (CLAUDE.md today =
  // CONTEXT + RULES) get ONE atomic multi-region write. Single-entry
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
      const onDisk = readOptional(abs);
      let hadMergeConflict = false;
      const regions = managed.map((e) => {
        const block = e.block;
        if (!block) {
          throw new Error(`manifest entry ${e.path}: managedBlock mode missing 'block'`);
        }
        const theirs = buildRegion(block, renderEntry(e, vars));
        const merged = mergeManagedRegions
          ? mergeManagedRegion(abs, e.path, block, theirs, ancestors)
          : { text: theirs, conflict: false, cleanTheirs: theirs };
        if (merged.conflict) hadMergeConflict = true;
        // Capture ancestor unconditionally (pre-write snapshot) so a later
        // merge run has a base even if this run was strip-replace.
        ancestors[`${e.path}::${block.begin}`] = theirs;
        return { block, regionText: merged.text };
      });
      // Managed-region conflict (per-file; never apply-to-all). Hand the
      // resolver the merged-with-markers bytes (the 6th "merge" option's
      // payload). Default behavior when no resolver is wired (or non-interactive):
      // write the merged-with-markers bytes + the SP-D stderr note (unchanged).
      if (hadMergeConflict) {
        const ctxMode: NonNullable<ConflictContext['mode']> = 'managedBlocks';
        const resolution = await resolveManagedConflict(relPath, ctxMode, opts);
        if (resolution === 'cancel') {
          throw new Error(`scaffold cancelled by user at conflicting file ${relPath}`);
        }
        // 'merge' / undefined → write the marked bytes (current behavior).
        if (resolution !== undefined && resolution !== 'merge') {
          // 'preserve' → skip the write entirely (user's overlap stands).
          // 'replace'/'duplicate'/'rename' → unsupported for managedBlocks
          // (managed regions are inside co-owned files); treat as 'merge'.
          process.stderr.write(
            `noir: managed-region conflict in ${relPath} — wrote inline markers; resolve manually.\n`,
          );
        } else {
          process.stderr.write(
            `noir: managed-region conflict in ${relPath} — wrote inline markers; resolve manually.\n`,
          );
        }
      }
      // Content-hash dedup: if the would-be-written bytes equal the on-disk
      // file, skip the write entirely (no mtime/git churn). `noir sync` on an
      // unchanged tree writes NOTHING.
      const predicted = predictManagedBlocks(onDisk ?? '', regions);
      if (onDisk !== undefined && predicted === onDisk) {
        identical.push(relPath);
      } else {
        managedBlocks(abs, regions);
        written.push(relPath);
      }
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
        const out = await writeRegenerateWithConflict(abs, entry.path, body, opts, {
          memory: conflictMemory,
          record: recordConflict,
        });
        written.push(...out.written);
        skipped.push(...out.skipped);
        identical.push(...out.identical);
      } else if (entry.mode === 'managedBlock') {
        const block = entry.block;
        if (!block) {
          throw new Error(`manifest entry ${entry.path}: managedBlock mode missing 'block'`);
        }
        // A legacy (pre-Slice-S) .noir/NOIR.md is a whole-file auto-brief
        // with NO managed markers. The normal path would treat the old brief
        // as user content and append a SECOND managed brief → two "Project
        // id:" lines. Self-heal: when the existing file has NO noir managed
        // marker at all, wipe it first so the managed write emits a clean
        // single brief. (Pre-Slice-S NOIR.md was 100% auto-generated, so
        // there is no user content to preserve in that legacy shape.)
        if (isNoirMdPath(entry.path)) healLegacyNoirMd(abs);
        const theirs = buildRegion(block, body);
        const merged = mergeManagedRegions
          ? mergeManagedRegion(abs, entry.path, block, theirs, ancestors)
          : { text: theirs, conflict: false, cleanTheirs: theirs };
        const regionText = merged.text;
        // Capture ancestor unconditionally (pre-write snapshot).
        ancestors[`${entry.path}::${block.begin}`] = theirs;
        // Managed-region conflict (per-file; never apply-to-all). Hand the
        // resolver the merged-with-markers bytes (the 6th "merge" option's
        // payload). Default behavior when no resolver is wired (or
        // non-interactive): write the merged-with-markers bytes + the SP-D
        // stderr note (unchanged from v1.2).
        if (merged.conflict) {
          const ctxMode: NonNullable<ConflictContext['mode']> = 'managedBlock';
          const onDiskRegion = readOptional(abs);
          const ctx: ConflictContext = {
            relPath: entry.path,
            existing: onDiskRegion ?? '',
            proposed: theirs,
            mode: ctxMode,
            similarity: similarity(onDiskRegion ?? '', merged.text),
            mergedWithMarkers: merged.text,
          };
          const resolution = await resolveManagedConflictCtx(ctx, opts);
          if (resolution === 'cancel') {
            throw new Error(`scaffold cancelled by user at conflicting file ${entry.path}`);
          }
          if (resolution === 'preserve') {
            identical.push(entry.path); // user's overlap stands; skip the write.
            continue;
          }
          process.stderr.write(
            `noir: managed-region conflict in ${entry.path} — wrote inline markers; resolve manually.\n`,
          );
        }
        // Content-hash dedup (post-heal: re-read, the heal may have wiped).
        // If the would-be-written bytes equal the on-disk file, skip the write
        // (no mtime/git churn) — a no-op `noir sync` writes NOTHING.
        const onDisk = readOptional(abs);
        const predicted = predictManagedBlock(onDisk ?? '', block, regionText);
        if (onDisk !== undefined && predicted === onDisk) {
          identical.push(entry.path);
        } else {
          managedBlock(abs, block, regionText);
          written.push(entry.path);
        }
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

  // Persist the ancestor snapshot UNCONDITIONALLY (every init/create/sync
  // seeds it) so the first merge run — now the default — has a base.
  // `writeAncestors` dedups internally: when the serialized bytes equal the
  // on-disk file, the rewrite is skipped, so a no-op sync leaves ancestors.json
  // untouched too (true zero-write idempotency).
  if (!opts.dryRun) {
    writeAncestors(opts.root, ancestors);
  }

  return {
    written,
    skipped,
    identical,
    conflicts: conflictRecords,
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

/** sha256 hex digest, truncated to 12 chars (git-short-style). Cheap,
 *  deterministic, collision-resistant enough for a single conflict report. */
function sha256Hex12(s: string): string {
  // `createHash` is lazy-imported so the engine stays import-side-effect-free
  // for callers that never touch the conflict path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
}

/** LCS-based similarity ratio in [0,1]. 1.0 = byte-identical lines, 0.0 =
 *  wholly disjoint. Cheap signal the resolver can use to bias toward `replace`
 *  when ~1 (cosmetic drift) vs `preserve` when ~0 (substantive edit). Reuses
 *  the SAME LCS as {@link mergeThreeWay} so there is one line-diff algorithm. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length === 0 && B.length === 0) return 1;
  // `lcsMatch` returns the paired anchor indices; |anchors| / max(len) is the
  // similarity. Re-derive here (without importing merge.ts) so the engine stays
  // decoupled from the merge module's diff3 specifics.
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const dpi = dp[i] ?? [];
    const dpi1 = dp[i + 1] ?? [];
    const ai = A[i] ?? '';
    for (let j = m - 1; j >= 0; j--) {
      const bj = B[j] ?? '';
      dpi[j] = ai === bj ? (dpi1[j + 1] ?? 0) + 1 : Math.max(dpi1[j] ?? 0, dpi[j + 1] ?? 0);
    }
  }
  const lcs = dp[0]?.[0] ?? 0;
  return n + m === 0 ? 1 : (2 * lcs) / (n + m);
}

// --- helpers -----------------------------------------------------------------

/** SP-D — three-way merge a managed region against the persisted ancestor
 *  (`base`). `theirs` is the freshly-rendered template region (with markers);
 *  `ours` is the region currently on disk. With no ancestor / no existing
 *  region this is a no-op (returns `theirs`). On conflict, returns the merged
 *  bytes WITH zdiff3 markers as `text` AND `conflict: true`, so the per-file
 *  scaffold site can hand the resolver a 6th "merge (with conflict markers)"
 *  option. `cleanTheirs` is the un-merged template — what the
 *  `'replace'` resolution would write. */
function mergeManagedRegion(
  abs: string,
  relPath: string,
  block: ManagedBlock,
  theirs: string,
  ancestors: Record<string, string>,
): { text: string; conflict: boolean; cleanTheirs: string } {
  const base = ancestors[`${relPath}::${block.begin}`];
  if (base === undefined) return { text: theirs, conflict: false, cleanTheirs: theirs };
  const ours = readManagedBlock(abs, block);
  if (ours === null) return { text: theirs, conflict: false, cleanTheirs: theirs };
  // `readManagedBlock` returns the matched region WITHOUT the trailing `\n`
  // after `end`, while `buildRegion`/`theirs` INCLUDE it. Feeding the raw `ours`
  // into mergeThreeWay makes every merge return a region missing that newline,
  // so the writer would drop it on each sync (byte drift) AND the content-hash
  // dedup could never fire (predicted !== onDisk by one `\n`). Normalize `ours`
  // to `theirs`'s shape (always end with `\n`) so an unchanged region stays
  // byte-identical and `noir sync` on an unchanged tree is a true no-op.
  const oursNormalized = ours.endsWith('\n') ? ours : `${ours}\n`;
  // zdiff3 markers so the resolver's 6th option shows the base section.
  const res = mergeThreeWay(base, oursNormalized, theirs, 'zdiff3');
  return { text: res.merged, conflict: res.conflict, cleanTheirs: theirs };
}

/** Consult {@link ScaffoldOptions.onConflict} for a managed-region merge
 *  conflict (single-block path). Per-file (never apply-to-all — user edits
 *  inside a `<!-- noir:* -->` region need individual review). When no resolver
 *  is wired OR the engine is non-interactive, returns `undefined` so the caller
 *  falls through to the v1.2 behavior (write the merged-with-markers bytes +
 *  the SP-D stderr note). Returns the resolver's bare resolution choice. */
async function resolveManagedConflictCtx(
  ctx: ConflictContext,
  opts: ScaffoldOptions,
): Promise<ConflictResolution | undefined> {
  if (opts.onConflict === undefined) return undefined;
  const ret = await opts.onConflict(ctx);
  const resolution = typeof ret === 'string' ? ret : ret.resolution;
  if (resolution === 'rename' || resolution === 'duplicate') {
    // Not meaningful for a region INSIDE a co-owned file. Treat as 'merge'
    // (write the marked bytes — the user keeps both sides, manually resolves).
    return 'merge';
  }
  if (resolution === 'replace') {
    // 'replace' on a managed region → write the clean template (clobber the
    // user's overlap inside this region). The caller writes `cleanTheirs`
    // (the un-merged template region) instead of the marked merge.
    return 'replace';
  }
  // 'merge' / 'preserve' / 'cancel' — pass through.
  return resolution;
}

/** Consult {@link ScaffoldOptions.onConflict} for a managed-region merge
 *  conflict (multi-block path). Simpler than the single-block path: the
 *  multi-block file is written atomically as ONE unit, so 'rename'/'duplicate'
 *  /'replace' have no clean meaning (the regions live alongside user content in
 *  a co-owned file). Only 'merge' (write the marked bytes), 'preserve' (skip),
 *  and 'cancel' (abort) are honored; others fall through to 'merge'. */
async function resolveManagedConflict(
  relPath: string,
  mode: NonNullable<ConflictContext['mode']>,
  opts: ScaffoldOptions,
): Promise<ConflictResolution | undefined> {
  if (opts.onConflict === undefined) return undefined;
  const ret = await opts.onConflict({ relPath, existing: '', proposed: '', mode });
  const resolution = typeof ret === 'string' ? ret : ret.resolution;
  return resolution;
}

/** Read the `.noir/project.id` stamp ONCE and classify it for BOTH id
 *  resolution and the corrupt-file heal. `absent` (ENOENT) and `valid`
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
  internals: {
    /** Per-run memory keyed by artifact CLASS (`'regenerate'`) — populated when
     *  a resolver returns `applyToAll`. */
    memory: Map<string, ConflictResolution>;
    /** Append a structured record for `ScaffoldResult.conflicts`. */
    record: (
      relPath: string,
      mode: NonNullable<ConflictContext['mode']>,
      existing: string,
      proposed: string,
      resolution: ConflictResolution,
      similarity?: number,
    ) => void;
  },
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
  // Apply-to-all memory: a regenerate file's class shares one decision
  // across the run (so a `noir init --upgrade` over N pointers → 1 prompt).
  const MODE: NonNullable<ConflictContext['mode']> = 'regenerate';
  const sim = similarity(existing, proposed);
  let resolution: ConflictResolution;
  const remembered = internals.memory.get(MODE);
  if (remembered !== undefined) {
    resolution = remembered;
  } else if (opts.onConflict !== undefined) {
    const ret = await opts.onConflict({ relPath, existing, proposed, mode: MODE, similarity: sim });
    const unwrapped: ConflictResolution = typeof ret === 'string' ? ret : ret.resolution;
    if (typeof ret !== 'string' && ret.applyToAll === true) {
      internals.memory.set(MODE, unwrapped);
    }
    resolution = unwrapped;
  } else {
    resolution = opts.conflictPolicy === 'preserve' ? 'preserve' : 'replace';
  }
  // Record the conflict ALWAYS (interactive or not) so `--json`/CI can see
  // exactly which files diverged + how the engine resolved them. The prompt
  // never fires under non-interactive (buildConflictOpts returns preserve w/o
  // onConflict); the record still lands.
  internals.record(relPath, MODE, existing, proposed, resolution, sim);
  switch (resolution) {
    case 'replace':
      regenerate(abs, proposed);
      return { written: [relPath], skipped: [], identical: [] };
    case 'merge': {
      // `merge` is only meaningful when ctx.mergedWithMarkers was populated
      // (managed-region path). For a bare regenerate conflict without markers
      // the resolver should not pick `merge`; defensively fall back to replace
      // (better than dropping the user's bytes).
      regenerate(abs, proposed);
      return { written: [relPath], skipped: [], identical: [] };
    }
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
 *  target). Scoped so the legacy-heal only fires for that one file — we must
 *  not wipe arbitrary co-owned managed files. */
function isNoirMdPath(relPath: string): boolean {
  return relPath === '.noir/NOIR.md';
}

/** Self-heal: wipe a legacy (pre-Slice-S) NOIR.md before the managed write.
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

/** Read a file as UTF-8, returning `undefined` when it is absent (ENOENT).
 *  Used by the content-hash dedup to read the on-disk bytes ONCE per managed
 *  target and feed them to the predictor + the byte-equality check. Any other
 *  read error re-throws (a real IO failure should not be silenced into a
 *  mistaken "identical → skip write"). */
function readOptional(absPath: string): string | undefined {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}
