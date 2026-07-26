/**
 * @noir-ai/create — the Noir scaffold engine.
 *
 * Public surface (consumed by `@noir-ai/cli` in S-T2 and by tests):
 *  - {@link scaffold} — the orchestrator for init/create/sync.
 *  - {@link buildManifest} + {@link ManifestEntry} — the declarative artifact table.
 *  - {@link regenerate} / {@link managedBlock} / {@link skipIfExists} — the
 *    three-mode writer (low-level; the orchestrator is the usual entry point).
 *  - {@link render} — `{{var}}` template interpolation.
 *  - {@link detectStack} — read-only stack detection.
 *  - {@link readScaffoldVersion} / {@link writeScaffoldVersion} /
 *    {@link CURRENT_SCAFFOLD_VERSION} — scaffold-version stamp.
 *  - {@link runMigrations} / {@link MIGRATIONS} — version-upgrade runner.
 *
 * This package has NO bin in S-T1 (the spec's `npm create noir-ai` greenfield
 * entry point is a later slice). It is engine-only: cli (S-T2) imports it.
 */

export {
  BRIEF_BLOCK,
  type BuildHostArtifactsContext,
  type BuildManifestContext,
  buildHostArtifacts,
  buildManifest,
  type HostTag,
  MANIFEST_PATH_PARITY,
  type ManifestEntry,
} from './manifest.js';
export {
  applyInlineConflict,
  applyWithConflict,
  MIGRATIONS,
  type MigrationContext,
  type MigrationResult,
  type MigrationScript,
  runMigrations,
} from './migrations/index.js';
export {
  assertSafeRoot,
  type ConflictContext,
  type ConflictResolution,
  type ScaffoldMode,
  type ScaffoldOptions,
  type ScaffoldResult,
  scaffold,
} from './scaffold.js';
export {
  CURRENT_SCAFFOLD_VERSION,
  readScaffoldVersion,
  scaffoldVersionPath,
  writeScaffoldVersion,
} from './scaffold-version.js';
export { detectStack, type StackInfo } from './stack-detect.js';
export { render } from './template.js';
export { loadTemplate, templatesDir } from './template-loader.js';
export {
  buildRegion,
  managedBlock,
  regenerate,
  skipIfExists,
  type WriteMode,
  type WriteOutcome,
} from './writers.js';
