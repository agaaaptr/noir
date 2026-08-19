import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type NoirConfig, parseConfig } from './config.js';
import { paths } from './layout.js';
import { isValidProjectId, type ProjectId } from './project-id.js';

export interface ProjectInfo {
  id: ProjectId;
  name: string;
  root: string;
  config: NoirConfig;
}

export function loadProjectInfo(root: string): ProjectInfo {
  let rawId: string;
  let rawConfig: unknown;
  try {
    rawId = readFileSync(paths.projectId(root), 'utf8').trim();
    rawConfig = parseYaml(readFileSync(paths.config(root), 'utf8'));
  } catch {
    throw new Error(`Noir is not initialized in ${root}. Run \`noir init\` first.`);
  }
  // Reject a non-UUID id (which could carry `/`, `..`, or an absolute segment)
  // before it ever reaches a path join — the ProjectId "never a filesystem
  // path" invariant is enforced here, the single load boundary.
  if (!isValidProjectId(rawId)) {
    throw new Error(
      `Noir is not initialized in ${root} (invalid project id). Run \`noir init\` first.`,
    );
  }
  const config = parseConfig(rawConfig);
  return {
    id: rawId,
    name: config.name ?? basename(root),
    root,
    config,
  };
}
