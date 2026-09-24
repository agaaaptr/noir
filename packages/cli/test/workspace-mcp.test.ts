// The `.mcp.json` writer behind `daemon join` / `workspace leave`.
//
// Joining points the repo's `noir` entry at the workspace through the stdio
// bridge, leaving returns that entry to plain stdio, and both rewrite ONLY the
// keys that describe how a host reaches the server — anything else the user put
// on the entry (`env`, `headers`, `headersHelper`) is theirs and stays. Every
// test here runs offline against a real temp repo.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceRegistry, paths, readWorkspaceMarker } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Joining must not spawn a real daemon (offline + fast). The address it would
// answer on is irrelevant to the writer under test, which only needs the name.
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
import { writeStdioEntry, writeWorkspaceEntry } from '../src/workspace-mcp.js';

const WORKSPACE = 'demo';
const MCP_FILE = '.mcp.json';

/** Plain stdio — what a repo has before it joins anything. */
const STDIO = { command: 'noir', args: ['mcp', 'serve', '--stdio'] };
/** The workspace entry: stdio that names the workspace for the bridge to resolve. */
const BRIDGE = { command: 'noir', args: ['mcp', 'serve', '--stdio', '--workspace', WORKSPACE] };
/** Wiring a user added by hand — none of it describes the transport. */
const USER_WIRING = {
  env: { NOIR_LOG: 'debug' },
  headers: { 'X-Api-Key': 'hand-added' },
  headersHelper: 'vault read -field=key',
};

let home: string;
let root: string;
let origCwd: string;

beforeEach(() => {
  process.env.NOIR_MCP_COMMAND = 'noir'; // pin the resolved command; no install record needed
  home = mkdtempSync(join(tmpdir(), 'noir-wsmcp-home-'));
  process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
  process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
  root = mkdtempSync(join(tmpdir(), 'noir-wsmcp-repo-'));
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

/** Seed a `.mcp.json` as a user might have written it: their entry + their own server. */
function seedConfig(noir: Record<string, unknown>): void {
  writeFileSync(
    join(root, MCP_FILE),
    `${JSON.stringify(
      { mcpServers: { noir, otherapi: { command: 'other-mcp' } }, topLevel: 1 },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function readConfig(): {
  mcpServers?: Record<string, Record<string, unknown>>;
  topLevel?: unknown;
} {
  return JSON.parse(readFileSync(join(root, MCP_FILE), 'utf8'));
}

function readNoirEntry(): Record<string, unknown> {
  return readConfig().mcpServers?.noir ?? {};
}

describe('the workspace MCP entry writer', () => {
  it('join writes a stdio entry that names the workspace for the bridge', () => {
    writeWorkspaceEntry(root, 'claude', WORKSPACE, {});
    expect(readNoirEntry()).toEqual(BRIDGE);
  });

  it('join keeps the user env block, their other servers and the file top level', () => {
    seedConfig({ ...STDIO, env: USER_WIRING.env });
    writeWorkspaceEntry(root, 'claude', WORKSPACE, {});
    expect(readNoirEntry()).toEqual({ ...BRIDGE, env: USER_WIRING.env });
    expect(readConfig().mcpServers?.otherapi).toEqual({ command: 'other-mcp' });
    expect(readConfig().topLevel).toBe(1);
  });

  it('join replaces an older http transport instead of leaving both on the entry', () => {
    seedConfig({ type: 'http', url: 'http://127.0.0.1:9/mcp?p=fe-repo', ...USER_WIRING });
    writeWorkspaceEntry(root, 'claude', WORKSPACE, {});
    expect(readNoirEntry()).toEqual({ ...BRIDGE, ...USER_WIRING });
  });

  it('join then leave both keep a hand-added headers key', () => {
    seedConfig({ ...STDIO, ...USER_WIRING });
    writeWorkspaceEntry(root, 'claude', WORKSPACE, {});
    expect(readNoirEntry()).toEqual({ ...BRIDGE, ...USER_WIRING });
    writeStdioEntry(root, 'claude', {});
    expect(readNoirEntry()).toEqual({ ...STDIO, ...USER_WIRING });
  });

  it('leave writes plain stdio back when the entry carried no user wiring', () => {
    writeWorkspaceEntry(root, 'claude', WORKSPACE, {});
    writeStdioEntry(root, 'claude', {});
    expect(readNoirEntry()).toEqual(STDIO);
  });
});

describe('noir daemon join / workspace leave', () => {
  it('join names the workspace; leave restores plain stdio and clears the marker', async () => {
    ensureWorkspaceRegistry(WORKSPACE);
    seedConfig({ ...STDIO, ...USER_WIRING });

    await daemonJoin({ name: WORKSPACE });
    expect(readWorkspaceMarker(root)).toBe(WORKSPACE);
    expect(readNoirEntry()).toEqual({ ...BRIDGE, ...USER_WIRING });

    await workspaceLeave({});
    expect(readWorkspaceMarker(root)).toBeNull();
    expect(readNoirEntry()).toEqual({ ...STDIO, ...USER_WIRING });
  });
});
