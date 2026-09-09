// Cross-repo "workspace" layout + registry — the user-scoped sharing unit that
// lets ≥2 agent sessions in DIFFERENT repositories share decision memory through
// one detached daemon (see docs/internal/specs/2026-09-09-shared-workspace-context-design.md).
//
// Everything here is HOME-relative under `~/.noir/workspaces/<name>/` (never a
// project `.noir/`), keyed by a NAME — the machine-stable identity a group of
// repos opts into, distinct from any single project's canonical ProjectId. The
// registry (registry.json) is the single source of truth for who may talk to the
// workspace daemon; a project's join marker (`.noir/workspace.json`) is a local
// pointer that makes its CLI memory commands route to the workspace daemon.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noirHome } from './layout.js';
import type { ProjectId } from './project-id.js';

export const WORKSPACES_DIR_ENV = 'NOIR_WORKSPACES_DIR';
/** Workspace names are path-safe + single-segment (a dir name under workspaces/). */
export const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** User-global workspace root: `~/.noir/workspaces/` (NOIR_WORKSPACES_DIR override). */
export function workspaceHomeDir(): string {
  return process.env[WORKSPACES_DIR_ENV] ?? join(noirHome(), 'workspaces');
}

/** A single workspace's directory. Throws on an invalid name (never joins a bad path). */
export function workspaceDir(name: string): string {
  if (!isValidWorkspaceName(name))
    throw new Error(`invalid workspace name: ${JSON.stringify(name)}`);
  return join(workspaceHomeDir(), name);
}

export function workspaceRegistryPath(name: string): string {
  return join(workspaceDir(name), 'registry.json');
}

export function workspaceStoreDbPath(name: string): string {
  return join(workspaceDir(name), 'store.db');
}

export function workspaceMarkerPath(root: string): string {
  return join(root, '.noir', 'workspace.json');
}

export function isValidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name);
}

export interface WorkspaceMember {
  projectId: ProjectId;
  root: string;
  joinedAt: number;
}

export interface WorkspaceRegistry {
  name: string;
  createdAt: number;
  members: WorkspaceMember[];
}

export function readWorkspaceRegistry(name: string): WorkspaceRegistry | null {
  try {
    const raw = readFileSync(workspaceRegistryPath(name), 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceRegistry;
    if (!Array.isArray(parsed.members)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read-or-create the registry for `name` (create-if-absent; never clobbers members). */
export function ensureWorkspaceRegistry(name: string): WorkspaceRegistry {
  const existing = readWorkspaceRegistry(name);
  if (existing !== null) return existing;
  const reg: WorkspaceRegistry = { name, createdAt: Date.now(), members: [] };
  writeWorkspaceRegistry(reg);
  return reg;
}

export function writeWorkspaceRegistry(reg: WorkspaceRegistry): void {
  const p = workspaceRegistryPath(reg.name);
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  renameSync(tmp, p);
}

/** Add-or-replace a member by projectId (idempotent). Returns the persisted registry. */
export function upsertWorkspaceMember(
  reg: WorkspaceRegistry,
  member: WorkspaceMember,
): WorkspaceRegistry {
  const next: WorkspaceRegistry = {
    ...reg,
    members: [...reg.members.filter((m) => m.projectId !== member.projectId), member],
  };
  writeWorkspaceRegistry(next);
  return next;
}

export function removeWorkspaceMember(
  reg: WorkspaceRegistry,
  projectId: string,
): WorkspaceRegistry {
  const next: WorkspaceRegistry = {
    ...reg,
    members: reg.members.filter((m) => m.projectId !== projectId),
  };
  writeWorkspaceRegistry(next);
  return next;
}

export function isWorkspaceMember(reg: WorkspaceRegistry, projectId: string): boolean {
  return reg.members.some((m) => m.projectId === projectId);
}

export function readWorkspaceMarker(root: string): string | null {
  try {
    const raw = readFileSync(workspaceMarkerPath(root), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

export function writeWorkspaceMarker(root: string, name: string): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(workspaceMarkerPath(root), `${JSON.stringify({ name }, null, 2)}\n`, 'utf8');
}

export function clearWorkspaceMarker(root: string): void {
  if (existsSync(workspaceMarkerPath(root))) rmSync(workspaceMarkerPath(root), { force: true });
}
