// Shared SHA-256 helper for @noir-ai/context — re-exported from @noir-ai/core
// (the canonical implementation; context already depends on core). Both the
// chunker (parentDocId / chunkId keys) and the indexer (file-content skip key)
// hash with the same UTF-8 SHA-256 hex digest — ONE definition, no drift.
export { sha256Hex } from '@noir-ai/core';
