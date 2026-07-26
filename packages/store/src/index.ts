export type {
  MarkdownConflictContext,
  MarkdownConflictOpts,
  MarkdownConflictResolution,
  MarkdownConflictResolver,
  MarkdownConflictResolverReturn,
} from './markdown.js';
export { migrate } from './migrations.js';
export { openStore } from './sqlite-store.js';
export type {
  EmbedFn,
  FtsHit,
  IndexDoc,
  OpenOptions,
  SearchFtOpts,
  Store,
  VecHit,
  VecOpts,
  VecUpsertMeta,
} from './types.js';
export { type VecAvailability, vecAvailability } from './vec-probe.js';
