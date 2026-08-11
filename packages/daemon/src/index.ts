// ContextStatus is defined in @noir-ai/context (the engine's own status type);
// re-exported here so the daemon's public surface carries it alongside
// StoreStatus / WorkflowStatus.
export type { ContextStatus } from '@noir-ai/context';
export {
  buildRequests,
  executeOp,
  InvalidOp,
  parseH2Tasks,
  previewRows,
} from './clickup-write.js';
export { buildContextEngine } from './context-seam.js';
export { type EnsureResult, ensureDaemonRunning } from './ensure.js';
export { type RunningDaemon, type StartHttpOptions, startHttpServer } from './http.js';
export {
  buildIntegrationService,
  findBinding,
  type IntegrationAuditEntry,
  type IntegrationBinding,
  type IntegrationService,
  resolveToken,
  shortNameOf,
  writeIntegrationAudit,
} from './integration-seam.js';
export {
  clearDaemonRecord,
  type DaemonRecord,
  daemonJsonPath,
  noirHome,
  pidAlive,
  readDaemonRecord,
  writeDaemonRecord,
} from './lifecycle.js';
export {
  buildMemoryEngine,
  resolveConsolidationCapability,
  resolveMemoryConsolidation,
} from './memory-seam.js';
export {
  createNoirServer,
  type ServerContext,
  type StoreStatus,
  type WorkflowStatus,
} from './server.js';
export { type SpawnTiming, spawnDetachedDaemon } from './spawn.js';
export { buildStatus, type HostStatus, type StatusContext, type Transport } from './status.js';
export { startStdioServer } from './stdio.js';
export { type DaemonStore, openStoreForDaemon } from './store-seam.js';
export { buildWorkflowEngine, resolveGateConfig } from './workflow-seam.js';
