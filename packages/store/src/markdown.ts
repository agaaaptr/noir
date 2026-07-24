import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Export all documents from the `docs` table to markdown files.
 *
 * Each document is written to `<dir>/<id>.md` with YAML frontmatter
 * containing `id` and `source`, followed by the document content.
 *
 * @param db - The SQLite database connection.
 * @param dir - The directory to write markdown files to.
 * @returns Array of written file paths.
 */
export async function exportMarkdown(db: Database.Database, dir: string): Promise<string[]> {
  const rows = db.prepare('SELECT id, source, content FROM docs').all() as {
    id: string;
    source: string;
    content: string;
  }[];
  const written: string[] = [];
  for (const r of rows) {
    const p = join(dir, `${r.id}.md`);
    writeFileSync(p, `---\nid: ${r.id}\nsource: ${r.source}\n---\n\n${r.content}\n`, 'utf8');
    written.push(p);
  }
  return written;
}
