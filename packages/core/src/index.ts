export {
  commentStyleFor,
  readManagedBlock,
  stripManagedBlock,
  writeManagedRegion,
} from './block-writer.js';
export { IGNORE_BLOCK, syncIgnores } from './ignore-manager.js';
export { type NoirConfig, NoirConfigSchema, parseConfig } from './config.js';
export { modelsDir, NOIR_DIR, noirHome, paths } from './layout.js';
export {
  CONTEXT_BLOCK,
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  type CommentStyle,
  type ManagedBlock,
  managedBlock,
  RULES_BLOCK,
} from './markers.js';
export { loadProjectInfo, type ProjectInfo } from './project.js';
export { createProjectId, type ProjectId } from './project-id.js';
export { NOIR_VERSION } from './version.js';
