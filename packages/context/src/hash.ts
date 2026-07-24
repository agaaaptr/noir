// Shared SHA-256 helper for @noir-ai/context.
//
// Both the chunker (parentDocId / chunkId keys) and the indexer
// (file-content skip key) hash with the same UTF-8 SHA-256 hex digest;
// keep ONE definition here so the two cannot drift.

import { createHash } from 'node:crypto';

/** UTF-8 SHA-256 hex digest. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
