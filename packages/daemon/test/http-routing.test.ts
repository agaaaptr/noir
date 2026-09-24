// HTTP routing for both daemon flavours.
//
// A project daemon serves ONE project at `/mcp` with no query string; a
// workspace daemon serves many members at `/mcp?p=<projectId>`. Both routes are
// matched on the parsed pathname, so a query string selects within a route
// rather than falling past it. These tests pin the two defects that used to
// hide a misdirected URL behind a bare 404:
//   • a workspace-shaped URL (`/mcp?p=…`) on a project daemon answers 400 with a
//     body naming the flavour mismatch, not 404 "path does not exist";
//   • a known path with an unsupported method answers 405 with an `Allow`
//     header, not 404.
// `/health` stays token-free in both flavours and tolerates a query string.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectInfo } from '@noir-ai/core';
import { ensureWorkspaceRegistry, parseConfig, paths, upsertWorkspaceMember } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { clearProjectDaemonRecord } from '../src/project-record.js';
import { readDaemonToken } from '../src/token.js';
import { startWorkspaceHttpServer } from '../src/workspace-http.js';
import { clearWorkspaceDaemonRecord } from '../src/workspace-record.js';

// Isolate the daemon records + tokens per vitest worker (file-parallelism safe).
// Both flavours are exercised in this file, so both homes are redirected.
const home = mkdtempSync(join(tmpdir(), 'noir-routing-home-'));
process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');

// A project daemon's root: its store opens under this tree, so keep it off any
// shared path.
const projectRoot = mkdtempSync(join(tmpdir(), 'noir-routing-proj-'));
// A workspace member repo, with the `.noir` identity a member lookup reads.
const memberRoot = mkdtempSync(join(tmpdir(), 'noir-routing-member-'));
mkdirSync(paths.noirDir(memberRoot), { recursive: true });
writeFileSync(paths.projectId(memberRoot), 'routing-member\n', 'utf8');
writeFileSync(
  paths.config(memberRoot),
  'host: claude\nmode: full\ncontext:\n  embedder:\n    kind: none\n',
  'utf8',
);

afterAll(() => {
  clearProjectDaemonRecord(project.id);
  clearWorkspaceDaemonRecord(WORKSPACE);
  rmSync(home, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(memberRoot, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'routingproj',
  name: 'routing-demo',
  root: projectRoot,
  config: parseConfig({
    host: 'claude',
    mode: 'full',
    context: { embedder: { kind: 'none' } },
  }),
};

const WORKSPACE = 'routing-ws';
const MEMBER_ID = 'routing-member';

/** The workspace daemon's bearer header (its token is scoped to the NAME). */
function authHeader(name: string): Record<string, string> {
  const token = readDaemonToken(name);
  if (token === null) throw new Error(`no workspace token on disk for ${name}`);
  return { Authorization: `Bearer ${token}` };
}

describe('project daemon HTTP routing', () => {
  it('answers 400 for a workspace-shaped URL, 404 for unknown paths and 405 for a wrong method', async () => {
    clearProjectDaemonRecord(project.id);
    const { port, stop } = await startHttpServer({ project, idleTimeoutSec: 900 });
    const base = `http://127.0.0.1:${port}`;
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    try {
      expect(readDaemonToken(project.id)).not.toBeNull();

      // /mcp without a token → 401, unchanged.
      expect((await fetch(`${base}/mcp`, { ...post, body: '{}' })).status).toBe(401);

      // A workspace-shaped URL (`?p=`) is not this daemon's route: 400 naming the
      // flavour mismatch, never the misleading 404 that hid the real problem.
      const misdirected = await fetch(`${base}/mcp?p=${project.id}`, { ...post, body: '{}' });
      expect(misdirected.status).toBe(400);
      const body = (await misdirected.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/project daemon/);
      expect(body.error).toMatch(/workspace daemon/);

      // A genuinely unknown path stays 404.
      expect((await fetch(`${base}/nope`, { ...post, body: '{}' })).status).toBe(404);

      // A known path with an unsupported method → 405 + Allow, not 404.
      const wrongMethod = await fetch(`${base}/mcp`, { method: 'PUT', body: '' });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get('allow')).toContain('POST');
      const wrongHealth = await fetch(`${base}/health`, { method: 'PUT', body: '' });
      expect(wrongHealth.status).toBe(405);
      expect(wrongHealth.headers.get('allow')).toBe('GET');

      // /health routes on the pathname, so a query string is tolerated.
      expect((await fetch(`${base}/health?x=1`)).status).toBe(200);
    } finally {
      await stop();
      clearProjectDaemonRecord(project.id);
    }
  }, 20000);
});

describe('workspace daemon HTTP routing', () => {
  it('tolerates a query on /health, keeps 401 before 403, and answers 404/405 by path', async () => {
    upsertWorkspaceMember(ensureWorkspaceRegistry(WORKSPACE), {
      projectId: MEMBER_ID,
      root: memberRoot,
      joinedAt: Date.now(),
    });
    clearWorkspaceDaemonRecord(WORKSPACE);
    const { port, stop } = await startWorkspaceHttpServer({
      name: WORKSPACE,
      project: {
        id: MEMBER_ID,
        name: 'routing-founder',
        root: memberRoot,
        config: parseConfig({
          host: 'claude',
          mode: 'full',
          context: { embedder: { kind: 'none' } },
        }),
      },
      idleTimeoutSec: 0,
    });
    const base = `http://127.0.0.1:${port}`;
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    try {
      // /health with a query is still the token-free 200 probe.
      const health = await fetch(`${base}/health?x=1`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { workspace: string }).workspace).toBe(WORKSPACE);

      // /mcp?p=<member> without a token → 401 (the auth gate is AHEAD of the
      // membership check, so no caller can probe which projectIds are members).
      expect((await fetch(`${base}/mcp?p=${MEMBER_ID}`, { ...post, body: '{}' })).status).toBe(401);

      // With the token the same route is served: a valid initialize answers 200.
      const served = await fetch(`${base}/mcp?p=${MEMBER_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...authHeader(WORKSPACE),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'noir-test', version: '0.0.0' },
          },
        }),
      });
      expect(served.status).toBe(200);

      // A genuinely unknown path stays 404.
      expect((await fetch(`${base}/nope`, { ...post, body: '{}' })).status).toBe(404);

      // A known path with an unsupported method → 405 + Allow, not 404.
      const wrongMethod = await fetch(`${base}/mcp?p=${MEMBER_ID}`, { method: 'PUT', body: '' });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get('allow')).toContain('POST');
      const wrongHealth = await fetch(`${base}/health`, { method: 'PUT', body: '' });
      expect(wrongHealth.status).toBe(405);
      expect(wrongHealth.headers.get('allow')).toBe('GET');
    } finally {
      await stop();
      clearWorkspaceDaemonRecord(WORKSPACE);
    }
  }, 30000);
});
