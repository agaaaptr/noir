import { homedir } from 'node:os';
import { join } from 'node:path';

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

export const paths = {
  noirDir: (root: string) => join(root, NOIR_DIR),
  noirMd: (root: string) => join(root, NOIR_DIR, 'NOIR.md'),
  rulesMd: (root: string) => join(root, NOIR_DIR, 'rules', 'RULES.md'),
  config: (root: string) => join(root, NOIR_DIR, 'config.yml'),
  projectId: (root: string) => join(root, NOIR_DIR, 'project.id'),
  storeDir: (root: string) => join(root, NOIR_DIR, 'store'),
  storeDb: (root: string, projectId: string) => join(root, NOIR_DIR, 'store', `${projectId}.db`),
  // Artifact directories and files
  specsDir: (root: string) => join(root, NOIR_DIR, 'specs'),
  specFile: (root: string, taskId: string, slug: string) =>
    join(root, NOIR_DIR, 'specs', `${taskId}-${slug}.md`),
  plansDir: (root: string) => join(root, NOIR_DIR, 'plans'),
  planFile: (root: string, taskId: string, slug: string) =>
    join(root, NOIR_DIR, 'plans', `${taskId}-${slug}.md`),
  tasksDir: (root: string) => join(root, NOIR_DIR, 'tasks'),
  taskFile: (root: string, taskId: string, taskName: string) =>
    join(root, NOIR_DIR, 'tasks', `${taskId}-${taskName}.md`),
  decisionsDir: (root: string) => join(root, NOIR_DIR, 'decisions'),
  decisionFile: (root: string, n: number) =>
    join(root, NOIR_DIR, 'decisions', `${String(n).padStart(4, '0')}.md`),
  auditDir: (root: string) => join(root, NOIR_DIR, 'audit'),
  auditFile: (root: string, taskId: string) => join(root, NOIR_DIR, 'audit', `${taskId}.json`),
} as const;
