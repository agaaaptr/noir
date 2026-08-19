import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ConflictResolution, uniqueAsideSync } from '@noir-ai/core';
import type Database from 'better-sqlite3';

/**
 * The SAME conflict-resolution seam @noir-ai/create's `regenerate` uses, built
 * on the shared `ConflictResolution` union + `uniqueAsideSync` helper from
 * @noir-ai/core (no create dependency). Default behavior is unchanged from v1.2
 * (overwrite): the seam fires only when a caller wires `onConflict`/`conflictPolicy`.
 */
export type MarkdownConflictResolution = ConflictResolution;

export interface MarkdownConflictContext {
  /** Path relative to the export dir (`<id>.md`). */
  relPath: string;
  existing: string;
  proposed: string;
  /** Always `'markdown'`. */
  mode: 'markdown';
}

export type MarkdownConflictResolverReturn =
  | MarkdownConflictResolution
  | { resolution: MarkdownConflictResolution; applyToAll?: boolean };

export type MarkdownConflictResolver = (
  ctx: MarkdownConflictContext,
) => Promise<MarkdownConflictResolverReturn> | MarkdownConflictResolverReturn;

export interface MarkdownConflictOpts {
  /** Default `'overwrite'` (v1.2 backward-compatible). */
  conflictPolicy?: 'overwrite' | 'preserve';
  onConflict?: MarkdownConflictResolver;
  /** When `false`, the resolver is NEVER consulted (CI / --json never hangs). */
  interactive?: boolean;
}

/**
 * Export all documents from the `docs` table to markdown files.
 *
 * Each document is written to `<dir>/<id>.md` with YAML frontmatter
 * containing `id` and `source`, followed by the document content.
 *
 * Routes through the SAME conflict seam as `regenerate`. When the target
 * file exists AND differs from the proposed bytes AND a resolver is wired +
 * interactive, the resolver is consulted (Replace/Rename/Duplicate/Keep/
 * Cancel). Default (no opts / non-interactive): overwrite (v1.2 behavior).
 *
 * @param db - The SQLite database connection.
 * @param dir - The directory to write markdown files to.
 * @param conflict - Optional conflict-resolution opts.
 * @returns Array of written file paths.
 */
export async function exportMarkdown(
  db: Database.Database,
  dir: string,
  conflict?: MarkdownConflictOpts,
): Promise<string[]> {
  const rows = db.prepare('SELECT id, source, content FROM docs').all() as {
    id: string;
    source: string;
    content: string;
  }[];
  const written: string[] = [];
  for (const r of rows) {
    const p = join(dir, `${r.id}.md`);
    const proposed = `---\nid: ${r.id}\nsource: ${r.source}\n---\n\n${r.content}\n`;
    if (!resolveAndWrite(p, `${r.id}.md`, proposed, conflict)) continue;
    writeFileSync(p, proposed, 'utf8');
    written.push(p);
  }
  return written;
}

/** Consult the conflict seam before clobbering an existing differing
 *  file. Returns true when the caller should proceed with the write. Mirrors
 *  `workflow/artifacts.ts`'s `resolveAndWrite` (kept duplicated so neither
 *  package gains a cross-dep). */
function resolveAndWrite(
  abs: string,
  relPath: string,
  proposed: string,
  opts: MarkdownConflictOpts | undefined,
): boolean {
  if (opts === undefined || opts.onConflict === undefined) return true;
  const interactive =
    opts.interactive ??
    (process.env.NOIR_NON_INTERACTIVE === undefined || process.env.NOIR_NON_INTERACTIVE === '');
  if (!interactive) {
    return opts.conflictPolicy !== 'preserve';
  }
  let existing: string | undefined;
  try {
    existing = readFileSync(abs, 'utf-8');
  } catch {
    existing = undefined;
  }
  if (existing === undefined || existing === proposed) return true;
  const ret = opts.onConflict({ relPath, existing, proposed, mode: 'markdown' });
  const unwrapped: MarkdownConflictResolution =
    typeof ret === 'string' ? ret : (ret as { resolution: MarkdownConflictResolution }).resolution;
  switch (unwrapped) {
    case 'replace':
      return true;
    case 'preserve':
      return false;
    case 'cancel':
      return false;
    case 'rename': {
      const aside = uniqueAsideSync(abs, '.local');
      renameSync(abs, aside);
      return true;
    }
    case 'duplicate': {
      const aside = uniqueAsideSync(abs, '.noir');
      writeFileSync(aside, proposed, 'utf-8');
      return false;
    }
  }
}
