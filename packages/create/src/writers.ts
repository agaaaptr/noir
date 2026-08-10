import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ManagedBlock } from '@noir-ai/core';
import { stripManagedBlock, writeManagedRegion } from '@noir-ai/core';

/**
 * The three-mode writer — generalizes keystone-K's `writeManagedRegion` into
 * the declarative dispatch the scaffold manifest drives. Each mode maps 1:1 to
 * an artifact class in the spec §4.5 matrix:
 *
 *  - {@link regenerate}    — pure pointers (`.mcp.json`, `NOIR.md` brief, …).
 *                           Always overwritten, atomically.
 *  - {@link managedBlock}  — co-owned files (`CLAUDE.md` context/rules,
 *                           `.gitignore` noir block, …). DELEGATES to
 *                           keystone-K's `writeManagedRegion` so user content
 *                           outside the markers is preserved byte-for-byte and
 *                           re-runs are idempotent. Never duplicate the
 *                           managed-region logic.
 *  - {@link skipIfExists}  — user-owned seeds (`RULES.md`, `config.yml`,
 *                           `project.id`). Write once; never clobber.
 *
 * The orchestrator (`scaffold.ts`) is the only intended caller; the per-mode
 * functions are exported so the cli (S-T2) and tests can drive them directly
 * when a one-off write is needed outside the manifest.
 */

export type WriteMode = 'regenerate' | 'managedBlock' | 'skipIfExists' | 'mergeJson';

export interface WriteOutcome {
  /** The absolute path that was written. */
  path: string;
  mode: WriteMode;
  /** true when bytes hit disk; false for skipIfExists no-ops. regenerate and
   *  managedBlock always write (managedBlock may write identical bytes — that
   *  still counts as a write for telemetry purposes; the file IS up to date). */
  written: boolean;
}

/** Atomic overwrite. Writes to `<file>.tmp.<pid>.<rnd>` in the same directory,
 *  fsyncs, then renames over the target so a crash never leaves a half-written
 *  file (the pointer files this is used for are read by the host agent first —
 *  a truncated CLAUDE.md/.mcp.json would break the very startup Noir serves).
 *
 *  Parent directories are NOT created here — the orchestrator does that once
 *  for the whole manifest so a missing dir is a single, attributable failure
 *  rather than N silent ones inside the writer. */
export function regenerate(absPath: string, content: string): WriteOutcome {
  const dir = dirname(absPath);
  const tmp = join(
    dir,
    `.${basename(absPath)}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`,
  );
  // Open with 'w' truncates; writeSync + closeSync before rename so the bytes
  // are durable pre-swap. O_SYNC would be stronger but is platform-flaky; the
  // rename is the real atomicity guarantee on POSIX (and practical-enough on
  // the win32 targets Noir supports).
  //
  // M1: the tmp MUST be cleaned up on EVERY exit path. The previous shape only
  // ran `rmSync(tmp)` when `renameSync` threw, so a `writeSync` failure (disk
  // full, EPERM, …) left the tmp behind. A single try/finally with `force:true`
  // rmSync (no-op ENOENT after a successful rename consumed the file) covers
  // both.
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, content, 0, 'utf8');
    closeSync(fd);
    fd = undefined; // closed cleanly — don't re-close in finally
    renameSync(tmp, absPath);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort: the rename/rm below are the meaningful cleanups */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
  }
  return { path: absPath, mode: 'regenerate', written: true };
}

/** Re-emit a managed region, delegating to keystone-K's `writeManagedRegion`.
 *  `regionText` MUST already include the begin/end markers (matches the shape
 *  `writeManagedRegion` expects and that `IGNORE_BLOCK`/`CONTEXT_BLOCK`
 *  callers build in core/cli). Use {@link buildRegion} to assemble it from a
 *  block + body. */
export function managedBlock(
  absPath: string,
  block: ManagedBlock,
  regionText: string,
): WriteOutcome {
  writeManagedRegion(absPath, block, regionText);
  return { path: absPath, mode: 'managedBlock', written: true };
}

/** Atomically (re)emit MULTIPLE managed regions into the SAME file in one
 *  pass. Used when a co-owned target carries more than one managed block —
 *  today only `CLAUDE.md` (CONTEXT + RULES).
 *
 *  WHY this exists: calling {@link managedBlock} twice on the same file is
 *  NOT byte-idempotent. The 2nd call strips ONLY its own block, treats the 1st
 *  region (and the `\n\n` separator) as user content, `trimEnd`s it, and
 *  re-appends a fresh `\n\n` separator. Re-runs therefore accumulate ~2 leading
 *  `\n` bytes per init (verified: 158→168 over 5 runs). Doing both regions in a
 *  SINGLE read → strip-all → append-all pass removes the interleaving: after
 *  stripping BOTH blocks the only thing left is real user content, so re-runs
 *  produce identical bytes.
 *
 *  Strategy:
 *   1. Read the file (missing → empty).
 *   2. Strip EVERY named block (via core's `stripManagedBlock`, in the given
 *      order) — what remains is user content + any managed blocks outside this
 *      group.
 *   3. Append all `regionText`s in the GIVEN ORDER, joined by a single `\n`.
 *      Each `regionText` already ends with `\n` (buildRegion appends the end
 *      marker's trailing newline), so `\n` between regions yields exactly one
 *      blank-line separator (`END\n` + `\n` + `BEGIN`) — byte-identical to what
 *      the single-block path emits on a first run, so the CONTEXT/RULES parity
 *      gates against `claudeAdapter.emitContext/emitRules` keep passing.
 *
 *  Single-region files (NOIR.md brief, ignore files) do NOT route through here
 *  — the orchestrator only calls this for groups of ≥2 managed blocks, so
 *  single-region byte-stability (delegated to keystone-K `writeManagedRegion`)
 *  is unchanged. */
export function managedBlocks(
  absPath: string,
  regions: ReadonlyArray<{ block: ManagedBlock; regionText: string }>,
): WriteOutcome {
  if (regions.length === 0) {
    throw new Error('managedBlocks requires at least one region');
  }
  if (regions.length === 1) {
    const only = regions[0];
    if (!only) throw new Error('managedBlocks: undefined region');
    return managedBlock(absPath, only.block, only.regionText);
  }
  let content = '';
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    /* missing → treat as empty */
  }
  let stripped = content;
  for (const r of regions) {
    stripped = stripManagedBlock(stripped, r.block);
  }
  const regionsJoined = regions.map((r) => r.regionText).join('\n');
  // Whitespace-only remainder (typical on re-run after both blocks are
  // stripped) → emit just the regions, no leading separator.
  const next =
    stripped.trim().length > 0 ? `${stripped.trimEnd()}\n\n${regionsJoined}` : regionsJoined;
  writeFileSync(absPath, next, 'utf8');
  return { path: absPath, mode: 'managedBlock', written: true };
}

/** Assemble `<begin>\n<body>\n<end>\n` for a managed block. Centralized here so
 *  every caller (manifest rendering, tests, future migrations) produces the
 *  exact byte shape `writeManagedRegion` strips/expects. The trailing newline
 *  is part of the contract — `stripManagedBlock`'s regex eats a trailing `\n`
 *  so re-runs stay idempotent instead of accumulating blank lines.
 *
 *  `body` is `trimEnd()`-ed before wrapping so template authors can keep the
 *  conventional trailing newline in `.tmpl` files without producing a
 *  double-newline before the end marker. This keeps the output byte-identical
 *  to `claudeAdapter.emitContext`/`emitRules` and core's `syncIgnores`, which
 *  S-T2 relies on for a diff-free refactor. */
export function buildRegion(block: ManagedBlock, body: string): string {
  return `${block.begin}\n${body.trimEnd()}\n${block.end}\n`;
}

/** Compute the exact byte content a {@link managedBlock} write would produce,
 *  WITHOUT touching disk. Mirrors core's `writeManagedRegion` byte-for-byte
 *  (`stripManagedBlock` + `trimEnd` + `\n\n` separator + `regionText`) so the
 *  orchestrator's content-hash dedup (skip an unchanged managed region) and
 *  the writer always agree on every byte. Pass the CURRENT on-disk content;
 *  the predictor never reads the file itself (the orchestrator reads once and
 *  reuses the bytes for both predict + compare). */
export function predictManagedBlock(
  currentContent: string,
  block: ManagedBlock,
  regionText: string,
): string {
  const stripped = stripManagedBlock(currentContent, block);
  return stripped ? `${stripped.trimEnd()}\n\n${regionText}` : regionText;
}

/** Compute the exact byte content a {@link managedBlocks} (multi-region) write
 *  would produce, WITHOUT touching disk. Mirrors the multi-region writer's
 *  strip-all + append-all pass (the single-region case delegates to
 *  {@link predictManagedBlock}). Used by the content-hash dedup so a
 *  multi-region file (CLAUDE.md CONTEXT+RULES) that is already up to date is
 *  skipped — `noir sync` on an unchanged tree writes NOTHING. */
export function predictManagedBlocks(
  currentContent: string,
  regions: ReadonlyArray<{ block: ManagedBlock; regionText: string }>,
): string {
  if (regions.length === 0) {
    throw new Error('predictManagedBlocks requires at least one region');
  }
  if (regions.length === 1) {
    const only = regions[0];
    if (!only) throw new Error('predictManagedBlocks: undefined region');
    return predictManagedBlock(currentContent, only.block, only.regionText);
  }
  let stripped = currentContent;
  for (const r of regions) {
    stripped = stripManagedBlock(stripped, r.block);
  }
  const regionsJoined = regions.map((r) => r.regionText).join('\n');
  return stripped.trim().length > 0 ? `${stripped.trimEnd()}\n\n${regionsJoined}` : regionsJoined;
}

/** Write `content` to `absPath` only if no file exists there. Returns whether
 *  bytes were written. Parent dirs are NOT created (orchestrator's job). */
export function skipIfExists(absPath: string, content: string): WriteOutcome {
  if (existsSync(absPath)) {
    return { path: absPath, mode: 'skipIfExists', written: false };
  }
  writeFileSync(absPath, content, 'utf8');
  return { path: absPath, mode: 'skipIfExists', written: true };
}

/**
 * Merge-aware JSON write (C3 SessionStart hook). `settings.local.json` is JSON
 * and CANNOT carry `<!-- noir:* -->` managed markers, so it is neither
 * `managedBlock` (would need comments) nor `regenerate` (would clobber the
 * user's `permissions`/`env`/`enabledPlugins`) nor `skipIfExists` (would go
 * stale). This path:
 *  1. Reads the existing file (missing → `{}`).
 *  2. Preserves EVERY existing top-level key (`permissions`, `env`, `hooks`, …).
 *  3. Merges the provided `patch` object — for `hooks` arrays, the existing
 *     arrays are kept and entries whose command already contains the given
 *     `dedupSubstring` are NOT re-added (context-mode's alreadyRegistered
 *     pattern — the entry is written once, never clobbered).
 *  4. Writes atomically via the same tmp+rename as `regenerate` when the merged
 *     bytes differ (content-hash dedup: an unchanged `noir sync` writes nothing).
 *
 * `patch` is a deep-merge target: top-level keys merge by key; `hooks.*` arrays
 * append-with-dedup. Other arrays replace only when provided. Returns the same
 * `WriteOutcome` shape. */
export function mergeJson(
  absPath: string,
  patch: Record<string, unknown>,
  dedupSubstring?: string,
): WriteOutcome {
  let existing: Record<string, unknown> = {};
  if (existsSync(absPath)) {
    try {
      existing = JSON.parse(readFileSync(absPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Corrupt/unparseable existing file — treat as empty, the merge will
      // produce a valid file (the old bytes are preserved in git if versioned).
      existing = {};
    }
  }

  const merged = deepMergePreservingHooks(existing, patch, dedupSubstring);
  const content = `${JSON.stringify(merged, null, 2)}\n`;

  // Content-hash dedup — a no-op sync writes nothing.
  if (existsSync(absPath)) {
    try {
      if (readFileSync(absPath, 'utf8') === content) {
        return { path: absPath, mode: 'mergeJson', written: false };
      }
    } catch {
      /* fall through and write */
    }
  }

  regenerate(absPath, content); // reuse the atomic tmp+rename path
  return { path: absPath, mode: 'mergeJson', written: true };
}

/** Deep-merge `patch` into `existing`. `hooks.*` arrays append-with-dedup
 *  (an entry whose command contains `dedupSubstring` is kept as-is, not
 *  re-added); other arrays replace only when present in the patch. */
function deepMergePreservingHooks(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  dedupSubstring?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'hooks' && typeof value === 'object' && value !== null) {
      const existingHooks = (out.hooks as Record<string, unknown> | undefined) ?? {};
      const mergedHooks: Record<string, unknown> = { ...existingHooks };
      for (const [event, entries] of Object.entries(value as Record<string, unknown>)) {
        const existingEntries = Array.isArray(mergedHooks[event])
          ? (mergedHooks[event] as unknown[])
          : [];
        const patchEntries = Array.isArray(entries) ? entries : [];
        // Append-only with dedup: only add patch entries whose command does NOT
        // already contain the dedup marker (the Noir hook was registered before —
        // write-once, never clobbered). A patch entry whose command itself is
        // missing is still added (caller bug, but non-fatal).
        const alreadyRegistered =
          dedupSubstring !== undefined &&
          existingEntries.some(
            (x) => (x as { command?: string })?.command?.includes(dedupSubstring) ?? false,
          );
        const toAdd = alreadyRegistered ? [] : patchEntries;
        mergedHooks[event] = [...existingEntries, ...toAdd];
      }
      out.hooks = mergedHooks;
    } else {
      // Non-hooks keys: patch wins, but only when the patch actually provides it.
      out[key] = value;
    }
  }
  return out;
}
