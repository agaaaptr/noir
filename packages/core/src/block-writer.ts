import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { CommentStyle, ManagedBlock } from './markers.js';

const HASH_FILES = new Set([
  '.gitignore',
  '.dockerignore',
  '.npmignore',
  '.prettierignore',
  '.eslintignore',
  '.ignore',
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pick a comment style for a managed region from a file path. */
export function commentStyleFor(file: string): CommentStyle {
  const lower = file.toLowerCase();
  if (HASH_FILES.has(basename(lower))) return 'hash';
  const ext = extname(lower);
  if (ext === '.yml' || ext === '.yaml') return 'hash';
  return 'html';
}

/** Remove every `<begin>…<end>` region for `block` from `content`. */
export function stripManagedBlock(content: string, block: ManagedBlock): string {
  const re = new RegExp(`${escapeRe(block.begin)}[\\s\\S]*?${escapeRe(block.end)}\\n?`, 'g');
  return content.replace(re, '');
}

/** Read the first `<begin>…<end>` region for `block` from `file`, or null if absent/missing. */
export function readManagedBlock(file: string, block: ManagedBlock): string | null {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = content.match(new RegExp(`${escapeRe(block.begin)}[\\s\\S]*?${escapeRe(block.end)}`));
  return m?.[0] ? m[0] : null;
}

/** Idempotently write `regionText` (a full `<begin>…<end>` block) into `file`,
 *  stripping any prior region for `block` and preserving all other content. */
export function writeManagedRegion(file: string, block: ManagedBlock, regionText: string): void {
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    /* missing → treat as empty */
  }
  const stripped = stripManagedBlock(content, block);
  const next = `${stripped ? `${stripped.trimEnd()}\n\n` : ''}${regionText}`;
  writeFileSync(file, next, 'utf8');
}
