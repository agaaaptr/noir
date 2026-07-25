import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createProjectId, paths } from '@noir-ai/core';
import {
  type BuildManifestContext,
  buildManifest,
  type HostTag,
  type ManifestEntry,
} from './manifest.js';
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
  /** Preview: compute the same written/skipped/migrated lists without touching
   *    disk. `noir doctor`/CI use this to report drift. */
  dryRun?: boolean;
}

export interface ScaffoldResult {
  /** Repo-relative paths actually written. */
  written: string[];
  /** Repo-relative paths skipIfExists'd (already present). */
  skipped: string[];
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

const WRITER_BY_MODE: Record<WriteMode, 'all' | 'runtime'> = {
  // 'runtime' subset = regenerate + managedBlock (the always-safe-to-rewrite
  // entries). sync + init --upgrade emit only this subset; skipIfExists is
  // reserved for first-run init/create so user edits survive.
  regenerate: 'runtime',
  managedBlock: 'runtime',
  skipIfExists: 'all',
};

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
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
  const manifest = buildManifest({ projectId, host, transport, url: opts.url });
  const emitRuntimeOnly = opts.mode === 'sync' || (opts.mode === 'init' && opts.upgrade === true);
  const vars: BuildManifestContext = { projectId, host, transport, url: opts.url };

  const written: string[] = [];
  const skipped: string[] = [];

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
        return { block, regionText: buildRegion(block, renderEntry(e, vars)) };
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
        regenerate(abs, body);
        written.push(entry.path);
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
        managedBlock(abs, block, buildRegion(block, body));
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

  return {
    written,
    skipped,
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
