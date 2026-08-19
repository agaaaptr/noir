import { join } from 'node:path';
import { writeManagedRegion } from './block-writer.js';
import { managedBlock } from './markers.js';

/** Managed-region marker for ignore-style files (hash comments). */
export const IGNORE_BLOCK = managedBlock('ignore', 'hash');

/** Default Noir entries per ignore file (derived/runtime artifacts only).
 *
 *  `/.noir/handoff/` is gitignored so `noir handoff --write` artifacts (host
 *  handoff prompts, often session-specific and machine-local) never pollute
 *  commits — they're paste-and-go prompts, not reviewed source. */
const IGNORE_ENTRIES: ReadonlyArray<[file: string, entries: readonly string[]]> = [
  [
    '.gitignore',
    [
      '/.noir/store/',
      '/.noir/handoff/',
      '/.noir/*.sock',
      '/.noir/daemon.pid',
      '/.noir/state/',
      // .noir/.env holds tokens — never commit it. The .env.example stays
      // visible as the documented placeholder (github/gitignore convention).
      '/.noir/.env',
      '/.noir/.env.*',
      '!/.noir/.env.example',
      // `noir run` transcripts may contain host prompts/output — runtime data,
      // not reviewed source.
      '/.noir/transcripts/',
    ],
  ],
  ['.dockerignore', ['.noir/']],
  ['.npmignore', ['/.noir/']],
  ['.prettierignore', ['/.noir/']],
];

/** Idempotently write Noir's managed ignore block into each configured ignore
 *  file under `root`, preserving all user content outside the block. Returns
 *  the list of files touched. Safe to re-run (managed-block replacement). */
export function syncIgnores(root: string): { files: string[] } {
  const files: string[] = [];
  for (const [name, entries] of IGNORE_ENTRIES) {
    const region = `${IGNORE_BLOCK.begin}\n${entries.join('\n')}\n${IGNORE_BLOCK.end}\n`;
    writeManagedRegion(join(root, name), IGNORE_BLOCK, region);
    files.push(name);
  }
  return { files };
}
