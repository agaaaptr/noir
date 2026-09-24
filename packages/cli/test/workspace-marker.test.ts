// A joined repo's MCP entry follows its workspace membership, not the transport
// flag a re-scaffold carries.
//
// Joining a workspace writes two things: the `.noir/workspace.json` marker and a
// `.mcp.json` `noir` entry that names the workspace for the stdio bridge. The
// manifest is what regenerates that entry on `noir sync` / `noir init`, and it
// knew nothing about the marker — so re-scaffolding a joined repo reverted it to
// plain stdio while the marker still claimed membership, leaving the config and
// the membership disagreeing about the same repo.
//
// A repo that joined under the older flow has the mirror-image problem: its
// entry is an `http://…/mcp?p=<projectId>` pointer to a daemon whose port and
// token have both moved on. `noir sync` cannot repair it — a differing
// `.mcp.json` is PRESERVED in a non-interactive run — so `init --upgrade` owns
// that rewrite, once and idempotently.
//
// Every test runs offline against a real temp repo: no daemon, no network, no
// API key.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, readWorkspaceMarker, writeWorkspaceMarker } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';
import { sync } from '../src/sync.js';
import { writeWorkspaceEntry } from '../src/workspace-mcp.js';

const WORKSPACE = 'demo';
const MCP = '.mcp.json';
const PROJECT_ID = '9f1c0b7e-0000-4000-8000-000000000000';
/** The scaffold version that shipped the joined-http flow — the newest version
 *  a repo can be stamped at and still hold an `http …?p=…` entry. A project at
 *  this stamp is exactly what `init --upgrade` has to reach. */
const PRE_UPGRADE = '1.2.0';
const LEGACY_URL = `http://127.0.0.1:4999/mcp?p=${PROJECT_ID}`;

/** Plain stdio — what an un-joined repo's entry looks like. */
const STDIO = { command: 'noir', args: ['mcp', 'serve', '--stdio'] };
/** The workspace entry: stdio that names the workspace for the bridge to resolve. */
const BRIDGE = { command: 'noir', args: ['mcp', 'serve', '--stdio', '--workspace', WORKSPACE] };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-wsmarker-'));
  // Pin the resolved MCP command so the emitted bytes are machine-independent.
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mcpPath = (): string => join(root, MCP);
const readMcp = (): string => readFileSync(mcpPath(), 'utf8');
const noirEntry = (): Record<string, unknown> => JSON.parse(readMcp()).mcpServers.noir;
const seedMcp = (noir: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
  writeFileSync(
    mcpPath(),
    `${JSON.stringify({ mcpServers: { noir, ...extra } }, null, 2)}\n`,
    'utf8',
  );
};

/** The two writes `noir daemon join` performs (minus the daemon): record the
 *  membership, then point the repo's `noir` entry at the workspace bridge. */
function joinWorkspace(name = WORKSPACE): void {
  writeWorkspaceMarker(root, name);
  writeWorkspaceEntry(root, 'claude', name, {});
}

/** A repo initialized by the release that shipped the joined-http flow: a valid
 *  project id, a config naming the host, an `http …?p=…` MCP entry and the
 *  workspace marker — but no `.noir/scaffold-version` advance since. */
function seedLegacyJoinedRepo(): void {
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${PROJECT_ID}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  writeFileSync(join(root, '.noir', 'scaffold-version'), `noir-scaffold=${PRE_UPGRADE}\n`, 'utf8');
  seedMcp({ type: 'http', url: LEGACY_URL }, { otherapi: { command: 'other-mcp' } });
  writeWorkspaceMarker(root, WORKSPACE);
}

describe('a joined repo keeps its workspace entry', () => {
  it('sync re-emits the workspace entry, leaving the file byte-identical', async () => {
    await init(root, { transport: 'stdio' });
    joinWorkspace();
    const before = readMcp();

    const res = await sync(root, {});

    expect(noirEntry()).toEqual(BRIDGE);
    expect(readMcp()).toBe(before);
    // The engine must see the on-disk entry as the one it would emit. A
    // differing `.mcp.json` is recorded as a conflict (and preserved, in a
    // non-interactive run) — so a conflict here is the downgrade the fix
    // removes, whether or not this particular run was allowed to write.
    expect(res.written).not.toContain(MCP);
    expect(res.identical).toContain(MCP);
    expect(res.conflicts.map((c) => c.path)).not.toContain(MCP);
  });

  it('init --force re-emits the workspace entry, leaving the file byte-identical', async () => {
    await init(root, { transport: 'stdio' });
    joinWorkspace();
    const before = readMcp();

    await init(root, { transport: 'stdio', force: true });

    expect(noirEntry()).toEqual(BRIDGE);
    expect(readMcp()).toBe(before);
  });

  it('keeps the user wiring the entry carried through a sync', async () => {
    await init(root, { transport: 'stdio' });
    joinWorkspace();
    // A key the workspace flow does not own, added by hand after joining.
    const wired = JSON.parse(readMcp()) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    wired.mcpServers.noir = { ...wired.mcpServers.noir, env: { NOIR_LOG: 'debug' } };
    writeFileSync(mcpPath(), `${JSON.stringify(wired, null, 2)}\n`, 'utf8');

    await sync(root, {});

    // `sync` re-emits the runtime subset and does not overwrite a `.mcp.json`
    // that differs from the template, so the entry keeps the user's key.
    // (`--force` is the explicit "overwrite the pointer file" mode and replaces
    // the whole file, as it does for every regenerated artifact.)
    expect(noirEntry()).toEqual({ ...BRIDGE, env: { NOIR_LOG: 'debug' } });
  });
});

describe('init --upgrade migrates a legacy http entry', () => {
  it('rewrites the stale http pointer to the bridge entry, keeping the user servers', async () => {
    seedLegacyJoinedRepo();

    const res = await init(root, { transport: 'stdio', upgrade: true });

    expect(noirEntry()).toEqual(BRIDGE);
    expect(res?.migrationChanged).toContain(MCP);
    // The migration edits ONE entry — the user's own server is not its business.
    const cfg = JSON.parse(readMcp()) as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers.otherapi).toEqual({ command: 'other-mcp' });
    expect(readMcp()).not.toContain('?p=');
  });

  it('is idempotent: a second upgrade leaves the file byte-identical', async () => {
    seedLegacyJoinedRepo();
    await init(root, { transport: 'stdio', upgrade: true });
    const migrated = readMcp();

    // Re-stamp the pre-upgrade version so the migration is asked to run again
    // rather than being skipped by the restamped project.
    writeFileSync(
      join(root, '.noir', 'scaffold-version'),
      `noir-scaffold=${PRE_UPGRADE}\n`,
      'utf8',
    );
    const res = await init(root, { transport: 'stdio', upgrade: true });

    expect(readMcp()).toBe(migrated);
    // The migration really ran and declined — otherwise an empty `changed` list
    // could just mean the runner skipped it, and this would prove nothing.
    expect(res?.migrationsRan).toContain('1.2.0→1.3.0');
    expect(res?.migrationChanged).toEqual([]);
  });
});

describe('a repo that never joined a workspace', () => {
  it('is byte-for-byte unchanged by sync, init --force and init --upgrade', async () => {
    await init(root, { transport: 'stdio' });
    const before = readMcp();

    await sync(root, {});
    expect(readMcp()).toBe(before);
    await init(root, { transport: 'stdio', force: true });
    expect(readMcp()).toBe(before);
    await init(root, { transport: 'stdio', upgrade: true });

    expect(readMcp()).toBe(before);
    expect(noirEntry()).toEqual(STDIO);
    expect(readMcp()).not.toContain('--workspace');
  });

  it('leaves an http entry alone: the migration keys on the marker, not the entry', async () => {
    // A repo that deliberately chose the streamable-http transport. There is no
    // marker, so it is not a stale workspace pointer and must not be rewritten.
    await init(root, { transport: 'streamable-http', url: 'http://127.0.0.1:4999/mcp' });
    writeFileSync(
      join(root, '.noir', 'scaffold-version'),
      `noir-scaffold=${PRE_UPGRADE}\n`,
      'utf8',
    );
    const before = readMcp();

    const res = await init(root, {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:4999/mcp',
      upgrade: true,
    });

    expect(readMcp()).toBe(before);
    // It ran and declined, as above: the marker is what the decision turns on.
    expect(res?.migrationsRan).toContain('1.2.0→1.3.0');
    expect(res?.migrationChanged).toEqual([]);
    expect(noirEntry()).toEqual({ type: 'http', url: 'http://127.0.0.1:4999/mcp' });
  });
});

describe('the marker is what decides', () => {
  it('a joined repo keeps the bridge even when the run asks for streamable-http', async () => {
    await init(root, { transport: 'stdio' });
    joinWorkspace();

    await init(root, {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:4999/mcp',
      force: true,
    });

    expect(noirEntry()).toEqual(BRIDGE);
    expect(readWorkspaceMarker(root)).toBe(WORKSPACE);
  });
});
