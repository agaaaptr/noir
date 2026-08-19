import { randomUUID } from 'node:crypto';

/** Canonical, machine-stable project identity. NEVER a filesystem path. */
export type ProjectId = string;

export function createProjectId(): ProjectId {
  return randomUUID();
}

/** A `ProjectId` is an arbitrary non-empty token that is PATH-SAFE — never a
 *  filesystem path, never containing a separator, `..`, or a leading `/`. (The
 *  canonical ids `createProjectId` produces are UUIDs, but human-readable test
 *  ids and existing projects use plain slugs; the invariant is "not a path",
 *  not "must be a UUID".) This check is the single authority: any id that
 *  fails is rejected before it is ever interpolated into a path (see
 *  `loadProjectInfo` + `paths.storeDb`), so a crafted `.noir/project.id` cannot
 *  escape `.noir/store/`. */
export function isValidProjectId(id: string): boolean {
  // Allowlist: start with an alphanumeric, then path-safe chars only. This
  // rejects separators, `..`, leading dots, control bytes, and the null byte UP
  // FRONT — so a crafted `.noir/project.id` can neither escape `.noir/store/`
  // (a `..`/separator would) nor crash the store-open with a null-byte path
  // error. Human-readable ids (`proj-test`, `g1-<uuid>`) and UUIDs all pass.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}
