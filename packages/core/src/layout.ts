import { homedir } from 'node:os';
import { join } from 'node:path';
import { artifactFileName } from './artifacts.js';

export const NOIR_DIR = '.noir';

/**
 * User-global Noir home: `~/.noir` (HOME-relative, NOT project `.noir/`).
 *
 * Hosts cross-project, user-scoped state — today the daemon record
 * (`~/.noir/daemon.json`, written by @noir-ai/daemon) and the embedding-model
 * cache ({@link modelsDir}). Kept HOME-relative so a single project checkout
 * stays portable across machines (blueprint: `ProjectId` is canonical, never a
 * filesystem path; the project `.noir/` dir never holds machine-local caches).
 */
export function noirHome(): string {
  return join(homedir(), NOIR_DIR);
}

/**
 * User-global cache for downloaded embedding-model weights: `~/.noir/models/`.
 *
 * Used by @noir-ai/context's local embedder (`@huggingface/transformers` pins
 * `env.cacheDir` here on first load). HOME-relative per spec OQ-7 (resolved) —
 * the ~22 MB MiniLM download is user-scoped, not per-project, so projects stay
 * portable and the weight is fetched at most once per machine.
 */
export function modelsDir(): string {
  return join(noirHome(), 'models');
}

/**
 * User-global managed-Node runtime root: `~/.noir/runtime/` by default.
 *
 * Each pinned Node LTS lives under here as `~/.noir/runtime/v<version>/`
 * (with its own `bin/node`, `bin/npm`), provisioned by
 * `@noir-ai/core`'s `provisionManagedNode()`. HOME-relative for the same
 * portability reason as {@link modelsDir} — the runtime is machine-local, not
 * per-project.
 *
 * `NOIR_RUNTIME_DIR` overrides the root (mirrors `NOIR_DAEMON_JSON` /
 * `NOIR_INSTALL_JSON`) so the offline unit suite can point at a tmpdir.
 */
export function runtimeDir(): string {
  return process.env.NOIR_RUNTIME_DIR ?? join(noirHome(), 'runtime');
}

export const paths = {
  noirDir: (root: string) => join(root, NOIR_DIR),
  noirMd: (root: string) => join(root, NOIR_DIR, 'NOIR.md'),
  rulesMd: (root: string) => join(root, NOIR_DIR, 'rules', 'RULES.md'),
  config: (root: string) => join(root, NOIR_DIR, 'config.yml'),
  projectId: (root: string) => join(root, NOIR_DIR, 'project.id'),
  storeDir: (root: string) => join(root, NOIR_DIR, 'store'),
  storeDb: (root: string, projectId: string) => join(root, NOIR_DIR, 'store', `${projectId}.db`),
  // Artifact directories and files — filenames follow the C3 generated-artifact
  // standard (`<CODE>-<NNNN>-<taskId>-<slug>.md`); see docs/reference/artifact-format.md
  specsDir: (root: string) => join(root, NOIR_DIR, 'specs'),
  specFile: (root: string, nnnn: number, taskId: string, slug: string) =>
    join(root, NOIR_DIR, 'specs', artifactFileName('spec', nnnn, { taskId, slug })),
  prdDir: (root: string) => join(root, NOIR_DIR, 'prd'),
  prdFile: (root: string, nnnn: number, taskId: string, slug: string) =>
    join(root, NOIR_DIR, 'prd', artifactFileName('prd', nnnn, { taskId, slug })),
  plansDir: (root: string) => join(root, NOIR_DIR, 'plans'),
  planFile: (root: string, nnnn: number, taskId: string, slug: string) =>
    join(root, NOIR_DIR, 'plans', artifactFileName('plan', nnnn, { taskId, slug })),
  tasksDir: (root: string) => join(root, NOIR_DIR, 'tasks'),
  taskFile: (root: string, nnnn: number, taskId: string, taskName: string) =>
    join(root, NOIR_DIR, 'tasks', artifactFileName('task', nnnn, { taskId, slug: taskName })),
  analysisDir: (root: string) => join(root, NOIR_DIR, 'analysis'),
  bugsDir: (root: string) => join(root, NOIR_DIR, 'bugs'),
  subagentsDir: (root: string) => join(root, NOIR_DIR, 'subagents'),
  clarificationsDir: (root: string) => join(root, NOIR_DIR, 'clarifications'),
  intakeDir: (root: string) => join(root, NOIR_DIR, 'intake'),
  handoffDir: (root: string) => join(root, NOIR_DIR, 'handoff'),
  decisionsDir: (root: string) => join(root, NOIR_DIR, 'decisions'),
  decisionFile: (root: string, nnnn: number, slug: string) =>
    join(root, NOIR_DIR, 'decisions', artifactFileName('adr', nnnn, { slug })),
  auditDir: (root: string) => join(root, NOIR_DIR, 'audit'),
  auditFile: (root: string, taskId: string) => join(root, NOIR_DIR, 'audit', `${taskId}.json`),
} as const;
