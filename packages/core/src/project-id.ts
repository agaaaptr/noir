import { randomUUID } from 'node:crypto';

/** Canonical, machine-stable project identity. NEVER a filesystem path. */
export type ProjectId = string;

export function createProjectId(): ProjectId {
  return randomUUID();
}
