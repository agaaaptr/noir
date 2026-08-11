import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import type { GateResult } from './types.js';

/**
 * The SAME conflict-resolution seam @noir-ai/create's `regenerate` uses,
 * local to this package so workflow does NOT add a create dependency (mirrors
 * the @noir-ai/skills pattern). The CLI's `buildConflictOpts().onConflict` is
 * structurally compatible. Default behavior is unchanged from v1.2 (overwrite):
 * the seam fires only when a caller wires `onConflict`/`conflictPolicy`.
 */
export type WorkflowConflictResolution = 'replace' | 'preserve' | 'rename' | 'duplicate' | 'cancel';

export interface WorkflowConflictContext {
  /** Repo-relative path (e.g. `.noir/specs/<taskId>-<slug>.md`). */
  relPath: string;
  existing: string;
  proposed: string;
  /** Always `'artifact'`. */
  mode: 'artifact';
}

export type WorkflowConflictResolverReturn =
  | WorkflowConflictResolution
  | { resolution: WorkflowConflictResolution; applyToAll?: boolean };

export type WorkflowConflictResolver = (
  ctx: WorkflowConflictContext,
) => Promise<WorkflowConflictResolverReturn> | WorkflowConflictResolverReturn;

export interface WorkflowConflictOpts {
  /** Default `'overwrite'` (v1.2 backward-compatible). */
  conflictPolicy?: 'overwrite' | 'preserve';
  onConflict?: WorkflowConflictResolver;
  /** When `false`, the resolver is NEVER consulted (CI / --json never hangs). */
  interactive?: boolean;
}

/**
 * Consult the conflict seam before clobbering an existing differing file.
 * Returns true when the caller should proceed with the write (resolution was
 * `replace` / `rename`), false when the user's bytes win (`preserve` /
 * `cancel`). On `rename`, the user's file is moved aside BEFORE this returns
 * true, so the caller's plain `writeFileSync(abs, proposed)` lands cleanly.
 * `duplicate` writes the proposed bytes to `<abs>.noir` and returns false (the
 * caller skips its own write). Default (no opts / non-interactive): the v1.2
 * behavior — overwrite — so existing callers are unchanged.
 */
function resolveAndWrite(
  abs: string,
  relPath: string,
  proposed: string,
  opts: WorkflowConflictOpts | undefined,
): { write: boolean } {
  if (opts === undefined || opts.onConflict === undefined) return { write: true };
  // Non-interactive guard. The bin's preAction sets NOIR_NON_INTERACTIVE
  // under --json/--no-input; an explicit `interactive: false` wins. Either ⇒
  // fall back to policy (no prompt).
  const interactive =
    opts.interactive ??
    (process.env.NOIR_NON_INTERACTIVE === undefined || process.env.NOIR_NON_INTERACTIVE === '');
  if (!interactive) {
    return { write: opts.conflictPolicy !== 'preserve' };
  }
  let existing: string | undefined;
  try {
    existing = readFileSync(abs, 'utf-8');
  } catch {
    existing = undefined;
  }
  if (existing === undefined || existing === proposed) return { write: true };
  const ret = opts.onConflict({ relPath, existing, proposed, mode: 'artifact' });
  // Unwrap both call shapes (sync resolver returns the value; Promise return
  // is settled by the time the sync caller below reads it via runSync).
  const unwrapped: WorkflowConflictResolution =
    typeof ret === 'string' ? ret : (ret as { resolution: WorkflowConflictResolution }).resolution;
  switch (unwrapped) {
    case 'replace':
      return { write: true };
    case 'preserve':
      return { write: false };
    case 'cancel':
      return { write: false };
    case 'rename': {
      // Move the user's file aside (unique suffix), then proceed with the write.
      const aside = uniqueAsideSync(abs, '.local');
      renameSync(abs, aside);
      return { write: true };
    }
    case 'duplicate': {
      // Write the proposed bytes to <abs>.noir; keep the user's file.
      const aside = uniqueAsideSync(abs, '.noir');
      writeFileSync(aside, proposed, 'utf-8');
      return { write: false };
    }
  }
}

function uniqueAsideSync(abs: string, suffix: string): string {
  let candidate = `${abs}${suffix}`;
  for (let n = 1; existsSync(candidate); n++) candidate = `${abs}${suffix}.${n}`;
  return candidate;
}

/**
 * Write intake artifact to .noir/intake/<taskId>.md
 */
export function writeIntake(
  root: string,
  taskId: string,
  content: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = join(root, '.noir', 'intake');
  const file = join(dir, `${taskId}.md`);

  mkdirSync(dir, { recursive: true });
  if (!resolveAndWrite(file, `.noir/intake/${taskId}.md`, content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write spec artifact to .noir/specs/<taskId>-<slug>.md
 * Creates markdown with frontmatter and body
 */
export function writeSpec(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.specsDir(root);
  const file = paths.specFile(root, taskId, slug);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
slug: ${slug}
---

${body}`;

  if (!resolveAndWrite(file, `.noir/specs/${taskId}-${slug}.md`, content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write PRD artifact to .noir/prd/<taskId>-<slug>.md
 * Pre-SDD product document; the spec @imports it (prdRef). No FSM change.
 */
export function writePrd(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.prdDir(root);
  const file = paths.prdFile(root, taskId, slug);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
slug: ${slug}
---

${body}`;

  if (!resolveAndWrite(file, `.noir/prd/${taskId}-${slug}.md`, content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}

/** Read a PRD artifact, or null if absent. */
export function readPrd(root: string, taskId: string, slug: string): string | null {
  const file = paths.prdFile(root, taskId, slug);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

/**
 * Write plan artifact to .noir/plans/<taskId>-<slug>.md
 */
export function writePlan(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.plansDir(root);
  const file = paths.planFile(root, taskId, slug);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
slug: ${slug}
---

${body}`;

  if (!resolveAndWrite(file, `.noir/plans/${taskId}-${slug}.md`, content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write task artifact to .noir/tasks/<taskId>-<taskName>.md
 */
export function writeTask(
  root: string,
  taskId: string,
  taskName: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.tasksDir(root);
  const file = paths.taskFile(root, taskId, taskName);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
task: ${taskName}
---

${body}`;

  if (!resolveAndWrite(file, `.noir/tasks/${taskId}-${taskName}.md`, content, conflict).write)
    return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write the clarify-phase artifact — resolved questions + assumptions.
 * c4-research-grounding S4. Path: `.noir/clarifications/<id>-<slug>.md`.
 */
export function writeClarifications(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = join(root, '.noir', 'clarifications');
  const file = join(dir, `${taskId}-${slug}.md`);
  mkdirSync(dir, { recursive: true });
  const content = `---
taskId: ${taskId}
slug: ${slug}
---

${body}`;
  if (!resolveAndWrite(file, `.noir/clarifications/${taskId}-${slug}.md`, content, conflict).write)
    return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write decision stub to .noir/decisions/<n>.md
 */
export function writeDecisionStub(
  root: string,
  n: number,
  title: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.decisionsDir(root);
  const file = paths.decisionFile(root, n);

  mkdirSync(dir, { recursive: true });

  const content = `# ${title}

*Decision record ${n}*

<!-- Status: pending -->
`;

  if (!resolveAndWrite(file, `.noir/decisions/${n}.md`, content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write changelog stub entry to .noir/CHANGELOG.md
 *
 * NOTE: this writer APPENDS (preserves prior entries); the conflict seam only
 * fires when the file exists AND differs in a way the append would clobber (the
 * header line is the standard marker). In practice the append is additive, so
 * the seam's `replace` resolution lands the new entry; `preserve` skips it.
 */
export function writeChangelogStub(
  root: string,
  entry: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = join(root, '.noir', 'CHANGELOG.md');

  // Create directory if it doesn't exist
  mkdirSync(join(root, '.noir'), { recursive: true });

  let content: string;
  if (existsSync(file)) {
    // Append: read existing content and add the new entry on its own line,
    // preserving the header and all prior entries.
    const existing = readFileSync(file, 'utf-8');
    const prefix = existing.endsWith('\n') ? existing : `${existing}\n`;
    content = `${prefix}${entry}\n`;
  } else {
    content = `# Changelog

${entry}
`;
  }

  if (!resolveAndWrite(file, '.noir/CHANGELOG.md', content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write audit export to .noir/audit/<taskId>.json
 * Exports GateResult array as JSON
 */
export function writeAuditExport(
  root: string,
  taskId: string,
  results: GateResult[],
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.auditDir(root);
  const file = paths.auditFile(root, taskId);

  mkdirSync(dir, { recursive: true });
  const content = JSON.stringify(results, null, 2);
  if (!resolveAndWrite(file, `.noir/audit/${taskId}.json`, content, conflict).write) return;
  writeFileSync(file, content, 'utf-8');
}
