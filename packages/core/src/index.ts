export {
  ARTIFACT_TYPES,
  type ArtifactFrontmatterInput,
  type ArtifactKind,
  artifactDir,
  artifactFileName,
  artifactFrontmatter,
  findArtifact,
  nextArtifactSequence,
  resolveArtifactPath,
  titleFromSlug,
} from './artifacts.js';
export {
  commentStyleFor,
  readManagedBlock,
  stripManagedBlock,
  writeManagedRegion,
} from './block-writer.js';
export { type NoirConfig, NoirConfigSchema, parseConfig } from './config.js';
export { applyNoirEnv, loadNoirEnv, parseEnvFile } from './env-file.js';
export { IGNORE_BLOCK, syncIgnores } from './ignore-manager.js';
export {
  type DetectResult,
  detectActiveMethod,
  detectInstallMethods,
  runManagerCmd,
  uninstallCommandFor,
} from './install-detect.js';
export {
  atomicWriteFile,
  clearInstallRecord,
  ensureShimExecutable,
  type InstallMethod,
  type InstallRecord,
  installJsonPath,
  nativeShimPath,
  readInstallRecord,
  resolveNoirCommand,
  writeInstallRecord,
} from './install-method.js';
export { modelsDir, NOIR_DIR, noirHome, paths, runtimeDir } from './layout.js';
export {
  CONTEXT_BLOCK,
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  type CommentStyle,
  type ManagedBlock,
  managedBlock,
  RULES_BLOCK,
} from './markers.js';
export {
  detectNodeTarget,
  downloadAndVerify,
  type ExecSeam,
  extractNode,
  type FetchSeam,
  MANAGED_NODE_VERSION,
  MIN_SYSTEM_NODE_MAJOR,
  type NodeTarget,
  nodeArchiveUrl,
  nodeDistBaseUrl,
  type ProvisionedNode,
  type ProvisionOptions,
  provisionManagedNode,
} from './node-provision.js';
export { loadProjectInfo, type ProjectInfo } from './project.js';
export { createProjectId, type ProjectId } from './project-id.js';
export {
  fetchLatestVersion,
  isUpdateCheckDisabled,
  isUpdateStale,
  latestVersionFromCache,
  readUpdateCache,
  shouldCheckForUpdate,
  type UpdateCache,
  type UpdateConfigLike,
  updateCachePath,
  writeUpdateCache,
} from './update-check.js';
export { NOIR_VERSION } from './version.js';
