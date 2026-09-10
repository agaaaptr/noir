import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ensureWorkspaceRegistry,
  isValidWorkspaceName,
  isWorkspaceMember,
  readWorkspaceRegistry,
  removeWorkspaceMember,
  upsertWorkspaceMember,
  workspaceDir,
  workspaceHomeDir,
  workspaceRegistryPath,
  workspaceStoreDbPath,
} from '../src/workspace.js';

const home = mkdtempSync(join(tmpdir(), 'noir-ws-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('workspaceHomeDir', () => {
  it('treats an empty NOIR_WORKSPACES_DIR as unset (never a relative CWD path)', () => {
    const saved = process.env.NOIR_WORKSPACES_DIR;
    try {
      delete process.env.NOIR_WORKSPACES_DIR;
      expect(workspaceHomeDir()).toContain('workspaces'); // default under ~/.noir
      process.env.NOIR_WORKSPACES_DIR = '';
      expect(workspaceHomeDir()).toContain('workspaces'); // empty ⇒ default, not ''
      process.env.NOIR_WORKSPACES_DIR = '   ';
      expect(workspaceHomeDir()).toContain('workspaces'); // whitespace ⇒ default
    } finally {
      if (saved === undefined) delete process.env.NOIR_WORKSPACES_DIR;
      else process.env.NOIR_WORKSPACES_DIR = saved;
    }
  });
});

describe('workspace name validation', () => {
  it('accepts path-safe names and rejects traversal/uppercase', () => {
    expect(isValidWorkspaceName('my-app')).toBe(true);
    expect(isValidWorkspaceName('a')).toBe(true);
    expect(isValidWorkspaceName('has.dots_ok')).toBe(false); // only [a-z0-9-]
    expect(isValidWorkspaceName('UPPER')).toBe(false);
    expect(isValidWorkspaceName('../evil')).toBe(false);
    expect(isValidWorkspaceName('a/b')).toBe(false);
    expect(() => workspaceDir('../evil')).toThrow(/invalid workspace name/);
  });
});

describe('workspace registry', () => {
  it('creates, persists, joins and leaves members idempotently', () => {
    const reg = ensureWorkspaceRegistry('my-app');
    expect(reg.members).toEqual([]);
    const member = { projectId: 'be-repo', root: '/tmp/be', joinedAt: 1 };
    const reg2 = upsertWorkspaceMember(reg, member);
    const reg2b = upsertWorkspaceMember(reg2, member); // idempotent (same projectId)
    expect(reg2b.members).toHaveLength(1);
    expect(isWorkspaceMember(reg2b, 'be-repo')).toBe(true);
    expect(isWorkspaceMember(reg2b, 'other')).toBe(false);
    const onDisk = readWorkspaceRegistry('my-app');
    expect(onDisk?.members[0]?.projectId).toBe('be-repo');
    const reg3 = removeWorkspaceMember(reg2b, 'be-repo');
    expect(reg3.members).toHaveLength(0);
    expect(existsSync(workspaceStoreDbPath('my-app'))).toBe(false);
    expect(workspaceRegistryPath('my-app')).toBe(join(workspaceDir('my-app'), 'registry.json'));
  });
});
