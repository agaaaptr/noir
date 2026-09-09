import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ensureWorkspaceRegistry, parseConfig, paths, readWorkspaceRegistry, upsertWorkspaceMember } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { clearDaemonRecord } from '../src/lifecycle.js';
import { startWorkspaceHttpServer } from '../src/workspace-http.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wsrout-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
process.env.NOIR_DAEMON_JSON = join(home, 'daemon.json');
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
  clearDaemonRecord();
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

describe('workspace http routing', () => {
  it('shares memory across members and refuses a non-member at the transport boundary', async () => {
    const founder = { projectId: 'repo-a', root: repoA, joinedAt: Date.now() };
    upsertWorkspaceMember(ensureWorkspaceRegistry('demo'), founder);
    upsertWorkspaceMember(readWorkspaceRegistry('demo')!, {
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
        config: parseConfig({ host: 'claude', mode: 'full', context: { embedder: { kind: 'none' } } }),
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
      const envelope = JSON.parse((saved.content?.[0] as { text: string }).text) as Record<string, unknown>;
      expect(envelope.ok).toBe(true);
      expect((envelope.observation as { repo?: string }).repo).toBe('repo-a');

      // member B recalls the same entry from the shared store
      const b = await mcpClient(port, 'repo-b');
      const recalled = await b.callTool({ name: 'memory_recall', arguments: { query: 'users contract' } });
      const renv = JSON.parse((recalled.content?.[0] as { text: string }).text) as Record<string, unknown>;
      expect(renv.ok).toBe(true);
      const hits = renv.results as Array<{ content: string; repo?: string }>;
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].repo).toBe('repo-a');

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
      clearDaemonRecord();
    }
  }, 30000);
});
