import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifactFrontmatter,
  type ConflictResolution,
  findArtifact,
  paths,
  resolveArtifactPath,
  titleFromSlug,
  uniqueAsideSync,
} from '@noir-ai/core';
import type { GateResult } from './types.js';

/**
 * The SAME conflict-resolution seam @noir-ai/create's `regenerate` uses, built
 * on the shared `ConflictResolution` union + `uniqueAsideSync` helper from
 * @noir-ai/core (no create dependency). The CLI's `buildConflictOpts().
 * onConflict` is structurally compatible. Default behavior is unchanged from
 * v1.2 (overwrite): the seam fires only when a caller wires `onConflict`/
 * `conflictPolicy`.
 */
export type WorkflowConflictResolution = ConflictResolution;

export interface WorkflowConflictContext {
  /** Repo-relative path (e.g. `.noir/specs/SP-0001-<taskId>-<slug>.md`). */
  relPath: string;
  existing: string;
  proposed: string;
  /** Always `'artifact'`. */
  mode: 'artifact';
}

export type WorkflowConflictResolverReturn =
  | WorkflowConflictResolution
  | { resolution: WorkflowConflictResolution; applyToAll?: boolean };

// SYNC resolver only: this seam is a synchronous wrapper around writeFileSync
// (resolveAndWrite cannot await). A caller needing an async resolver (e.g. the
// CLI's @clack-based one) should use @noir-ai/create's regenerate seam, which is
// async-aware — passing an async resolver here would unwrap a Promise object.
export type WorkflowConflictResolver = (
  ctx: WorkflowConflictContext,
) => WorkflowConflictResolverReturn;

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

/** Repo-relative path from an absolute artifact path + its type dir name. */
function relPathFor(file: string, dir: string): string {
  return `.noir/${dir}/${file.slice(file.lastIndexOf('/') + 1)}`;
}

/**
 * Write intake artifact to `.noir/intake/IN-<NNNN>-<taskId>.md`.
 */
export function writeIntake(
  root: string,
  taskId: string,
  content: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = resolveArtifactPath(root, 'intake', { taskId });
  mkdirSync(join(root, '.noir', 'intake'), { recursive: true });
  const full = `${artifactFrontmatter({ kind: 'intake', id: taskId })}\n\n${content}`;
  if (!resolveAndWrite(file, relPathFor(file, 'intake'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
}

/**
 * Write spec artifact to `.noir/specs/SP-<NNNN>-<taskId>-<slug>.md`.
 * Creates markdown with the C3 frontmatter and the body.
 */
export function writeSpec(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = resolveArtifactPath(root, 'spec', { taskId, slug });
  mkdirSync(paths.specsDir(root), { recursive: true });
  const full = `${artifactFrontmatter({ kind: 'spec', id: taskId, slug })}\n\n${body}`;
  if (!resolveAndWrite(file, relPathFor(file, 'specs'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
}

/**
 * Write PRD artifact to `.noir/prd/PRD-<NNNN>-<taskId>-<slug>.md`.
 * Pre-SDD product document; the spec @imports it (prdRef). No FSM change.
 */
export function writePrd(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = resolveArtifactPath(root, 'prd', { taskId, slug });
  mkdirSync(paths.prdDir(root), { recursive: true });
  const full = `${artifactFrontmatter({ kind: 'prd', id: taskId, slug })}\n\n${body}`;
  if (!resolveAndWrite(file, relPathFor(file, 'prd'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
}

/** Read a PRD artifact, or null if absent. */
export function readPrd(root: string, taskId: string, slug: string): string | null {
  const file = findArtifact(root, 'prd', { taskId, slug });
  if (!file) return null;
  return readFileSync(file, 'utf-8');
}

/**
 * Write plan artifact to `.noir/plans/PL-<NNNN>-<taskId>-<slug>.md`.
 */
export function writePlan(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = resolveArtifactPath(root, 'plan', { taskId, slug });
  mkdirSync(paths.plansDir(root), { recursive: true });
  const full = `${artifactFrontmatter({ kind: 'plan', id: taskId, slug })}\n\n${body}`;
  if (!resolveAndWrite(file, relPathFor(file, 'plans'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
}

/**
 * Write task artifact to `.noir/tasks/TS-<NNNN>-<taskId>-<taskName>.md`.
 */
export function writeTask(
  root: string,
  taskId: string,
  taskName: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = resolveArtifactPath(root, 'task', { taskId, slug: taskName });
  mkdirSync(paths.tasksDir(root), { recursive: true });
  const full = `${artifactFrontmatter({ kind: 'task', id: taskId, slug: taskName })}\n\n${body}`;
  if (!resolveAndWrite(file, relPathFor(file, 'tasks'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
}

/**
 * Write the clarify-phase artifact — resolved questions + assumptions.
 * `.noir/clarifications/CL-<NNNN>-<taskId>-<slug>.md`.
 */
export function writeClarifications(
  root: string,
  taskId: string,
  slug: string,
  body: string,
  conflict?: WorkflowConflictOpts,
): void {
  const file = resolveArtifactPath(root, 'clarification', { taskId, slug });
  mkdirSync(join(root, '.noir', 'clarifications'), { recursive: true });
  const full = `${artifactFrontmatter({ kind: 'clarification', id: taskId, slug })}\n\n${body}`;
  if (!resolveAndWrite(file, relPathFor(file, 'clarifications'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
}

/**
 * Write decision stub to `.noir/decisions/ADR-<NNNN>-<slug>.md` with the Nygard
 * heading shape (Context → Decision → Consequences) and `status: proposed`.
 */
export function writeDecisionStub(
  root: string,
  n: number,
  slug: string,
  title?: string,
  conflict?: WorkflowConflictOpts,
): void {
  const dir = paths.decisionsDir(root);
  const file = paths.decisionFile(root, n, slug);
  const num = String(n).padStart(4, '0');
  const humanTitle = title ?? titleFromSlug(slug);
  const heading = `ADR-${num}: ${humanTitle}`;

  mkdirSync(dir, { recursive: true });

  const full = `${artifactFrontmatter({ kind: 'adr', id: `ADR-${num}`, slug, title: humanTitle, status: 'proposed' })}

# ${heading}

## Context

<fill in: value-neutral forces at play>

## Decision

<fill in: "We will …" full sentences, active voice>

## Consequences

<fill in: positive, negative, neutral>
`;

  if (!resolveAndWrite(file, relPathFor(file, 'decisions'), full, conflict).write) return;
  writeFileSync(file, full, 'utf-8');
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
