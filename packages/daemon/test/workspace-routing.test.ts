import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ensureWorkspaceRegistry, parseConfig, paths, upsertWorkspaceMember } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startWorkspaceHttpServer } from '../src/workspace-http.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wsrout-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
// Workspace daemons never touch the per-project daemon record, but keep the
// record dir off the real `~/.noir/daemons` in case a member boot does.
process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
const repoA = mkdtempSync(join(tmpdir(), 'noir-wsrout-a-'));
const repoB = mkdtempSync(join(tmpdir(), 'noir-wsrout-b-'));
const CONFIG = 'host: claude\nmode: full\ncontext:\n  embedder:\n    kind: none\n';
for (const [root, id] of [
  [repoA, 'repo-a'],
  [repoB, 'repo-b'],
] as const) {
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${id}\n`, 'utf8');
  writeFileSync(paths.config(root), CONFIG, 'utf8');
}
afterAll(() => {
  for (const d of [home, repoA, repoB]) rmSync(d, { recursive: true, force: true });
});

async function mcpClient(port: number, repo: string) {
  const client = new Client(
    { name: 'noir-test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?p=${repo}`)),
  );
  return client;
}

function parseResult(res: { content?: unknown }): Record<string, unknown> {
  const block = (res.content as Array<{ text?: string }> | undefined)?.[0];
  return JSON.parse(block?.text ?? '') as Record<string, unknown>;
}

describe('workspace http routing', () => {
  it('shares memory across members and refuses a non-member at the transport boundary', async () => {
    const founder = { projectId: 'repo-a', root: repoA, joinedAt: Date.now() };
    const reg = upsertWorkspaceMember(ensureWorkspaceRegistry('demo'), founder);
    upsertWorkspaceMember(reg, {
      projectId: 'repo-b',
      root: repoB,
      joinedAt: Date.now(),
    });

    const { port, stop } = await startWorkspaceHttpServer({
      name: 'demo',
      project: {
        id: 'repo-a',
        name: 'demo-founder',
        root: repoA,
        config: parseConfig({
          host: 'claude',
          mode: 'full',
          context: { embedder: { kind: 'none' } },
        }),
      },
      idleTimeoutSec: 0,
    });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as Record<string, unknown>;
      expect(body.workspace).toBe('demo');
      expect(body.memberCount).toBe(2);

      // member A saves → workspace store, repo stamped from request identity
      const a = await mcpClient(port, 'repo-a');
      const saved = await a.callTool({
        name: 'memory_save',
        arguments: { content: 'be contract: GET /users returns {items: User[]}' },
      });
      const envelope = parseResult(saved);
      expect(envelope.ok).toBe(true);
      const obs = envelope.observation as { repo?: string; status?: string; cursor?: number };
      expect(obs.repo).toBe('repo-a');
      expect(obs.status).toBe('active');
      expect(typeof obs.cursor).toBe('number');
      expect(obs.cursor).toBeGreaterThan(0);

      // member B recalls the same entry from the shared store
      const b = await mcpClient(port, 'repo-b');
      const recalled = await b.callTool({
        name: 'memory_recall',
        arguments: { query: 'users contract' },
      });
      const renv = parseResult(recalled);
      expect(renv.ok).toBe(true);
      const hits = renv.results as Array<{
        content: string;
        repo?: string;
        status?: string;
        cursor?: number;
      }>;
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].repo).toBe('repo-a');
      // Provenance must round-trip: the recall hydration (from the authoritative
      // KV row) carries the same status + feed cursor the save stamped.
      expect(hits[0].status).toBe('active');
      expect(hits[0].cursor).toBeGreaterThan(0);

      // non-member is refused at the transport boundary (before the MCP handshake)
      const refused = await fetch(`http://127.0.0.1:${port}/mcp?p=not-a-member`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(403);
      const refusedBody = (await refused.json()) as Record<string, unknown>;
      expect(refusedBody.ok).toBe(false);

      await Promise.all([a.close(), b.close()]);
    } finally {
      await stop();
    }
  }, 30000);

  it('refuses a member whose registered root no longer resolves to that projectId', async () => {
    // "ghost" is registered as a member, but its root is repoA whose REAL id is
    // repo-a — a stale pairing (re-`noir init` in place). The daemon must refuse
    // (500) rather than serve repo-a's store under the authenticated "ghost"
    // identity.
    upsertWorkspaceMember(ensureWorkspaceRegistry('stale-identity'), {
      projectId: 'ghost',
      root: repoA,
      joinedAt: Date.now(),
    });
    const { port, stop } = await startWorkspaceHttpServer({
      name: 'stale-identity',
      project: {
        id: 'repo-a',
        name: 'stale-founder',
        root: repoA,
        config: parseConfig({
          host: 'claude',
          mode: 'full',
          context: { embedder: { kind: 'none' } },
        }),
      },
      idleTimeoutSec: 0,
    });
    try {
      const refused = await fetch(`http://127.0.0.1:${port}/mcp?p=ghost`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(500);
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body.ok).toBe(false);
    } finally {
      await stop();
    }
  }, 30000);

  it('answers 500 — never hangs — when a member config is rejected after its store opens', async () => {
    // repoC passes config validation (core constrains `dim` only to a positive
    // int) but `resolveEmbedderConfig` throws mid-build, AFTER the store open.
    // The daemon must close that store, answer 500, and stay up — an unguarded
    // throw here would strand the handle and reject the request handler, which
    // has no catch, so the client would hang with no envelope.
    const repoC = mkdtempSync(join(tmpdir(), 'noir-wsrout-c-'));
    mkdirSync(paths.noirDir(repoC), { recursive: true });
    writeFileSync(paths.projectId(repoC), 'repo-c\n', 'utf8');
    writeFileSync(
      paths.config(repoC),
      'host: claude\nmode: full\ncontext:\n  embedder:\n    kind: remote\n    dim: 768\n',
      'utf8',
    );
    upsertWorkspaceMember(ensureWorkspaceRegistry('bad-config'), {
      projectId: 'repo-c',
      root: repoC,
      joinedAt: Date.now(),
    });
    const { port, stop } = await startWorkspaceHttpServer({
      name: 'bad-config',
      project: {
        id: 'repo-a',
        name: 'bad-config-founder',
        root: repoA,
        config: parseConfig({
          host: 'claude',
          mode: 'full',
          context: { embedder: { kind: 'none' } },
        }),
      },
      idleTimeoutSec: 0,
    });
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/mcp?p=repo-c`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(bad.status).toBe(500);
      expect(((await bad.json()) as Record<string, unknown>).ok).toBe(false);
      // The daemon survives the bad member (no leaked handle, no crash).
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      await stop();
      rmSync(repoC, { recursive: true, force: true });
    }
  }, 30000);
});
