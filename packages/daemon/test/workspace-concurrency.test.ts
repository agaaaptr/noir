import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ensureWorkspaceRegistry, parseConfig, paths, upsertWorkspaceMember } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { clearDaemonRecord } from '../src/lifecycle.js';
import { startWorkspaceHttpServer } from '../src/workspace-http.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wsconc-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
process.env.NOIR_DAEMON_JSON = join(home, 'daemon.json');
const rootA = mkdtempSync(join(tmpdir(), 'noir-wsconc-a-'));
mkdirSync(paths.noirDir(rootA), { recursive: true });
writeFileSync(paths.projectId(rootA), 'conc-a\n', 'utf8');
writeFileSync(
  paths.config(rootA),
  'host: claude\nmode: full\ncontext:\n  embedder:\n    kind: none\n',
  'utf8',
);
afterAll(() => {
  clearDaemonRecord();
  rmSync(home, { recursive: true, force: true });
  rmSync(rootA, { recursive: true, force: true });
});

async function mkClient(port: number) {
  const client = new Client(
    { name: 'noir-conc', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?p=conc-a`)),
  );
  return client;
}

function parseResult(res: { content?: unknown }): Record<string, unknown> {
  const block = (res.content as Array<{ text?: string }> | undefined)?.[0];
  return JSON.parse(block?.text ?? '') as Record<string, unknown>;
}

describe('two concurrent clients on one workspace daemon', () => {
  it('interleaved writes are visible to both, and await_changes wakes across clients', async () => {
    upsertWorkspaceMember(ensureWorkspaceRegistry('conc'), {
      projectId: 'conc-a',
      root: rootA,
      joinedAt: Date.now(),
    });
    const { port, stop } = await startWorkspaceHttpServer({
      name: 'conc',
      project: {
        id: 'conc-a',
        name: 'conc',
        root: rootA,
        config: parseConfig({
          host: 'claude',
          mode: 'full',
          context: { embedder: { kind: 'none' } },
        }),
      },
      idleTimeoutSec: 0,
    });
    try {
      const c1 = await mkClient(port);
      const c2 = await mkClient(port);
      const write = (c: Client, content: string) =>
        c.callTool({ name: 'memory_save', arguments: { content } });
      await Promise.all([
        write(c1, 'c1 decision one'),
        write(c2, 'c2 decision two'),
        write(c1, 'c1 decision three'),
      ]);

      const read = await c2.callTool({ name: 'memory_recall', arguments: { query: 'decision' } });
      const env = parseResult(read) as {
        ok: boolean;
        results: Array<{ content: string }>;
      };
      expect(env.ok).toBe(true);
      expect(env.results.length).toBeGreaterThanOrEqual(3);

      // long-poll wakes: first learn the CURRENT cursor so await_changes actually
      // registers a waiter (polling with cursor:0 would short-circuit on the
      // three entries already written and prove nothing about the wake path).
      const cur = parseResult(
        await c1.callTool({ name: 'changes_since', arguments: { cursor: 0 } }),
      ) as {
        cursor: number;
      };
      const poll = c1.callTool({
        name: 'await_changes',
        arguments: { cursor: cur.cursor, timeoutMs: 10000 },
      });
      await new Promise((r) => setTimeout(r, 200));
      await write(c2, 'c2 wake the poller');
      const pollEnv = parseResult(await poll) as {
        ok: boolean;
        timedOut: boolean;
        changes: Array<{ summary: string }>;
      };
      expect(pollEnv.ok).toBe(true);
      expect(pollEnv.timedOut).toBe(false);
      // Only the ONE new write may have landed; it must be the wake entry, not the
      // three pre-existing ones the waiter was already past.
      expect(pollEnv.changes.some((c) => c.summary === 'c2 wake the poller')).toBe(true);

      await Promise.all([c1.close(), c2.close()]);
    } finally {
      await stop();
      clearDaemonRecord();
    }
  }, 30000);
});
