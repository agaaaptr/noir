import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NOIR_DIR } from './layout.js';
import { NOIR_VERSION } from './version.js';

/**
 * The canonical registry of `.noir/` artifact kinds — the SINGLE SOURCE OF TRUTH
 * for how generated files are named and where they live. The C3 quality gate
 * (`packages/skills/src/quality.ts`) cross-checks every `.noir/…` path a skill
 * prescribes against this table; the workflow writers and the CLI handoff
 * writer build filenames from it. See `docs/reference/artifact-format.md` +
 * `docs/decisions/0007-…` (C3 generated-artifact standard).
 */
export const ARTIFACT_TYPES = {
  task: { code: 'TS', dir: 'tasks', hasTaskId: true, hasSlug: true },
  spec: { code: 'SP', dir: 'specs', hasTaskId: true, hasSlug: true },
  plan: { code: 'PL', dir: 'plans', hasTaskId: true, hasSlug: true },
  prd: { code: 'PRD', dir: 'prd', hasTaskId: true, hasSlug: true },
  analysis: { code: 'AN', dir: 'analysis', hasTaskId: true, hasSlug: true },
  adr: { code: 'ADR', dir: 'decisions', hasTaskId: false, hasSlug: true },
  bug: { code: 'BG', dir: 'bugs', hasTaskId: true, hasSlug: true },
  brief: { code: 'BR', dir: 'subagents', hasTaskId: false, hasSlug: true },
  report: { code: 'RP', dir: 'subagents', hasTaskId: false, hasSlug: true },
  clarification: { code: 'CL', dir: 'clarifications', hasTaskId: true, hasSlug: true },
  intake: { code: 'IN', dir: 'intake', hasTaskId: true, hasSlug: false },
  handoff: { code: 'HO', dir: 'handoff', hasTaskId: true, hasSlug: false },
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_TYPES;

/** Absolute path of the type directory for `kind` under `<root>/.noir/`. */
export function artifactDir(root: string, kind: ArtifactKind): string {
  return join(root, NOIR_DIR, ARTIFACT_TYPES[kind].dir);
}

/** Path-safe token: forbid separators, `..`, and leading dots so a
 *  caller-supplied id cannot escape `.noir/` via a filename (the write paths
 *  join this into a real path). Replaced with `_` on collision. SHARED by the
 *  write name (`artifactFileName`) and the read match tail (`findArtifact`) so a
 *  name round-trips exactly — a file written as `TS-0001-foo_bar.md` is found by
 *  a `findArtifact` for `foo/bar`. */
function safe(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The canonical artifact filename: `<CODE>-<NNNN>-<taskId>-<slug>.md`.
 * `nnnn` is a per-type monotonic sequence (4 digits, zero-padded). `taskId`
 * and `slug` are included only for kinds that carry them (see the registry).
 */
export function artifactFileName(
  kind: ArtifactKind,
  nnnn: number,
  opts: { taskId?: string; slug?: string } = {},
): string {
  const t = ARTIFACT_TYPES[kind];
  const parts = [t.code, String(nnnn).padStart(4, '0')];
  if (t.hasTaskId && opts.taskId) parts.push(safe(opts.taskId));
  if (t.hasSlug && opts.slug) parts.push(safe(opts.slug));
  return `${parts.join('-')}.md`;
}

/**
 * Next per-type sequence number: scan `<root>/.noir/<dir>/` for files named
 * `<CODE>-NNNN-…` and return max+1 (1 when none). Mirrors the decision-stub
 * scan the CLI previously did inline. Per-type independent, never reused.
 */
export function nextArtifactSequence(root: string, kind: ArtifactKind): number {
  const dir = artifactDir(root, kind);
  const code = ARTIFACT_TYPES[kind].code;
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = name.match(/^([A-Z]+)-(\d+)-/);
    if (!m || m[1] !== code) continue;
    const digits = m[2];
    if (!digits) continue;
    const n = Number.parseInt(digits, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Locate an existing artifact by its identifying fields — for readers like
 * `readPrd` that used to derive the path deterministically from
 * `<taskId>-<slug>.md`. Returns the absolute path or `null`. Matches on the
 * trailing `-<taskId>-<slug>.md` (or `-<taskId>.md` / `-<slug>.md` as the kind
 * dictates), so the leading sequence number is irrelevant.
 */
export function findArtifact(
  root: string,
  kind: ArtifactKind,
  opts: { taskId?: string; slug?: string } = {},
): string | null {
  const dir = artifactDir(root, kind);
  if (!existsSync(dir)) return null;
  const t = ARTIFACT_TYPES[kind];
  const parts: string[] = [];
  // Apply the SAME sanitizer as artifactFileName so a written name (with `_`
  // substitutions) is matched back by the same inputs (with their original
  // characters) — one canonical name for both directions.
  if (t.hasTaskId && opts.taskId) parts.push(safe(opts.taskId));
  if (t.hasSlug && opts.slug) parts.push(safe(opts.slug));
  const tail = parts.length > 0 ? `-${parts.join('-')}.md` : '.md';
  for (const name of readdirSync(dir)) {
    if (name.endsWith(tail)) return join(dir, name);
  }
  return null;
}

/**
 * The path a writer should target: the existing artifact for the same
 * identifying fields (reuse → rewrites overwrite, not duplicate), else a fresh
 * path carrying the next sequence number. This is what keeps a second
 * `writeSpec(root, taskId, slug)` landing on the SAME file rather than minting
 * `SP-0002-…` beside `SP-0001-…`.
 */
export function resolveArtifactPath(
  root: string,
  kind: ArtifactKind,
  opts: { taskId?: string; slug?: string } = {},
): string {
  const existing = findArtifact(root, kind, opts);
  if (existing) return existing;
  const nnnn = nextArtifactSequence(root, kind);
  return join(artifactDir(root, kind), artifactFileName(kind, nnnn, opts));
}

/** Humanize a kebab slug for the frontmatter `title` (the body H1 stays canonical). */
export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface ArtifactFrontmatterInput {
  kind: ArtifactKind;
  /** The store key (`taskId`) — or `ADR-<NNNN>` for decisions. */
  id: string;
  slug?: string;
  status?: string;
  title?: string;
}

/**
 * The canonical frontmatter every `.md` artifact carries (see
 * `docs/reference/artifact-format.md`). Required fields: `kind`, `id`, `slug`
 * (when the kind has one), `title`, `status`, `date`, `generated_by`,
 * `generated_at`. Status defaults `draft` (or `proposed` for `adr`). Additive
 * over the v1.x `taskId`/`slug` — no reader parsed those keys.
 */
export function artifactFrontmatter(input: ArtifactFrontmatterInput): string {
  const { kind, id, slug, status, title } = input;
  const statusValue = status ?? (kind === 'adr' ? 'proposed' : 'draft');
  const titleValue = title ?? (slug ? titleFromSlug(slug) : id);
  const now = new Date();
  return [
    '---',
    `kind: ${kind}`,
    `id: ${id}`,
    ...(slug ? [`slug: ${slug}`] : []),
    `title: ${titleValue}`,
    `status: ${statusValue}`,
    `date: ${now.toISOString().slice(0, 10)}`,
    `generated_by: @noir-ai ${NOIR_VERSION}`,
    `generated_at: ${now.toISOString()}`,
    '---',
  ].join('\n');
}
