import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceRegistry, paths, readWorkspaceMarker } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the daemon's workspace ensure so join does not really spawn a detached
// server (offline + fast). Everything else (registry, marker, .mcp.json) is real.
vi.mock('@noir-ai/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noir-ai/daemon')>();
  return {
    ...actual,
    ensureWorkspaceDaemonRunning: vi.fn(async () => ({
      url: 'http://127.0.0.1:4321/mcp',
      port: 4321,
      started: true,
      stop: async () => {},
    })),
  };
});

import { daemonJoin, workspaceLeave } from '../src/commands/workspace.js';

let home: string;
let root: string;
let origCwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noir-wscli-home-'));
  process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
  process.env.NOIR_DAEMON_JSON = join(home, 'daemon.json');
  root = mkdtempSync(join(tmpdir(), 'noir-wscli-repo-'));
  origCwd = process.cwd();
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), 'fe-repo\n', 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  process.chdir(root);
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('noir daemon join / workspace leave', () => {
  it('join writes the marker + an http .mcp.json entry; leave restores stdio', async () => {
    ensureWorkspaceRegistry('demo'); // founder already created it

    await daemonJoin({ name: 'demo' });
    expect(readWorkspaceMarker(root)).toBe('demo');
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { type?: string; url?: string; command?: string; args?: string[] }>;
    };
    expect(mcp.mcpServers.noir?.type).toBe('http');
    expect(mcp.mcpServers.noir?.url).toContain('?p=fe-repo');

    await workspaceLeave({});
    expect(readWorkspaceMarker(root)).toBeNull();
    const restored = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { type?: string; url?: string; command?: string; args?: string[] }>;
    };
    expect(restored.mcpServers.noir?.command).toBeTruthy();
    expect(restored.mcpServers.noir?.args).toEqual(['mcp', 'serve', '--stdio']);
  });

  it('join fails cleanly when the workspace does not exist', async () => {
    await expect(daemonJoin({ name: 'missing' })).rejects.toThrow();
    expect(existsSync(join(root, '.noir', 'workspace.json'))).toBe(false);
  });
});
