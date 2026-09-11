// Workspace-daemon transport auth (spec 6.1 + §6.3) — the workspace parity of
// the project daemon's bearer token, asserted in http.test.ts.
//
// The scope key is the workspace NAME (a projectId is meaningless for a daemon
// spanning projects), so a workspace daemon's token can never be the token of
// any member repo's project daemon. `/mcp` requires the bearer and answers 401
// without it — BEFORE the membership check, so an unauthenticated caller cannot
// probe which projectIds are members. `/health` stays token-free (the workspace
// probe depends on it and its body carries no secret).
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ensureWorkspaceRegistry, parseConfig, paths, upsertWorkspaceMember } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { readDaemonToken, tokenPath } from '../src/token.js';
import { startWorkspaceHttpServer } from '../src/workspace-http.js';
import { clearWorkspaceDaemonRecord } from '../src/workspace-record.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wstoken-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
const repoA = mkdtempSync(join(tmpdir(), 'noir-wstoken-a-'));
mkdirSync(paths.noirDir(repoA), { recursive: true });
writeFileSync(paths.projectId(repoA), 'token-repo-a\n', 'utf8');
writeFileSync(
  paths.config(repoA),
  'host: claude\nmode: full\ncontext:\n  embedder:\n    kind: none\n',
  'utf8',
);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoA, { recursive: true, force: true });
});

const NAME = 'token-ws';
const FOUNDER_ID = 'token-repo-a';

function founder() {
  return {
    id: FOUNDER_ID,
    name: 'token-ws-founder',
    root: repoA,
    config: parseConfig({
      host: 'claude',
      mode: 'full',
      context: { embedder: { kind: 'none' } },
    }),
  };
}

/** Register repoA as a member of `name` (idempotent per test). */
function joinMember(name: string): void {
  upsertWorkspaceMember(ensureWorkspaceRegistry(name), {
    projectId: FOUNDER_ID,
    root: repoA,
    joinedAt: Date.now(),
  });
}

describe('workspace daemon token', () => {
  it('gates /mcp behind the bearer token, leaving /health token-free', async () => {
    joinMember(NAME);
    clearWorkspaceDaemonRecord(NAME);
    const { port, stop } = await startWorkspaceHttpServer({
      name: NAME,
      project: founder(),
      idleTimeoutSec: 0,
    });
    const mcp = `http://127.0.0.1:${port}/mcp?p=${FOUNDER_ID}`;
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    try {
      // The daemon minted a token for this lifecycle, on disk at 0600, keyed by
      // the WORKSPACE NAME — never by a member's projectId.
      const token = readDaemonToken(NAME);
      expect(token).not.toBeNull();
      expect(existsSync(tokenPath(NAME))).toBe(true);
      expect(readDaemonToken(FOUNDER_ID)).toBeNull();

      // /health is the probe's dependency: 200 with NO Authorization header.
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { ok: boolean; workspace: string };
      expect(healthBody.ok).toBe(true);
      expect(healthBody.workspace).toBe(NAME);

      // /mcp with no header → 401 naming the remediation (the token file).
      const anonymous = await fetch(mcp, { ...post, body: '{}' });
      expect(anonymous.status).toBe(401);
      const body = (await anonymous.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/unauthorized/);
      expect(body.error).toMatch(/Bearer/);
      expect(body.error).toContain(tokenPath(NAME));
      // The body names the file, never the secret (names only, never values).
      expect(body.error).not.toContain(token as string);

      // The WRONG bearer → still 401 (the token is actually compared).
      const wrong = await fetch(mcp, {
        ...post,
        headers: { ...post.headers, Authorization: 'Bearer not-the-token' },
        body: '{}',
      });
      expect(wrong.status).toBe(401);

      // The CORRECT bearer → past the gate (whatever the MCP layer makes of a
      // bare `{}` body, it is not an auth rejection).
      const withToken = await fetch(mcp, {
        ...post,
        headers: { ...post.headers, Authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(withToken.status).not.toBe(401);

      // A full MCP session over the same header succeeds end to end.
      const client = new Client(
        { name: 'noir-test', version: '0.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcp), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const result = await client.callTool({ name: 'host_status', arguments: {} });
      const block = result.content?.[0] as { type?: string; text?: string } | undefined;
      expect(block?.type).toBe('text');
      expect(JSON.parse(block?.text ?? '').daemon).toBe(true);
      await client.close();
    } finally {
      await stop();
      clearWorkspaceDaemonRecord(NAME);
    }
  }, 30000);

  it('answers 401 — before 403 — for an unauthenticated non-member (no membership leak)', async () => {
    joinMember(NAME);
    clearWorkspaceDaemonRecord(NAME);
    const { port, stop } = await startWorkspaceHttpServer({
      name: NAME,
      project: founder(),
      idleTimeoutSec: 0,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp?p=not-a-member`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // The auth gate runs first: an anonymous caller learns nothing about which
      // projectIds are members (403 would confirm "not a member").
      expect(res.status).toBe(401);
      const token = readDaemonToken(NAME);
      const authed = await fetch(`http://127.0.0.1:${port}/mcp?p=not-a-member`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
      // Authenticated, the membership check still refuses it.
      expect(authed.status).toBe(403);
    } finally {
      await stop();
      clearWorkspaceDaemonRecord(NAME);
    }
  }, 30000);

  it('mints a fresh token per start, clears it on shutdown, and stays 0600', async () => {
    joinMember(NAME);
    clearWorkspaceDaemonRecord(NAME);
    const first = await startWorkspaceHttpServer({
      name: NAME,
      project: founder(),
      idleTimeoutSec: 0,
    });
    const firstToken = readDaemonToken(NAME);
    expect(firstToken).not.toBeNull();
    // `mode` is a no-op on Windows (permissions are ACL-based), so the POSIX-mode
    // assertion is only meaningful elsewhere.
    if (process.platform !== 'win32') {
      expect(statSync(tokenPath(NAME)).mode & 0o777).toBe(0o600);
    }
    await first.stop();
    // Cleared on shutdown under the record-ownership guard: a client's copy
    // cannot outlive the process, and the next start mints a new secret.
    expect(readDaemonToken(NAME)).toBeNull();
    expect(existsSync(tokenPath(NAME))).toBe(false);

    const second = await startWorkspaceHttpServer({
      name: NAME,
      project: founder(),
      idleTimeoutSec: 0,
    });
    try {
      expect(readDaemonToken(NAME)).not.toBe(firstToken);
    } finally {
      await second.stop();
      clearWorkspaceDaemonRecord(NAME);
    }
  }, 30000);
});
