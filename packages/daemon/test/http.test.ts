import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ProjectInfo } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { clearProjectDaemonRecord } from '../src/project-record.js';

// Isolate the per-project daemon records per vitest worker (file-parallelism
// safe). `startHttpServer` writes this project's record under this dir.
const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-test-http-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

// Isolated project root so startHttpServer's store open doesn't leak a DB
// under a shared path like /tmp/http-demo.
const projectRoot = mkdtempSync(join(tmpdir(), 'noir-test-http-root-'));

afterAll(() => {
  clearProjectDaemonRecord(project.id);
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'http-demo',
  root: projectRoot,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

describe('startHttpServer', () => {
  it('serves /health 200 and host_status over Streamable HTTP', async () => {
    clearProjectDaemonRecord(project.id);
    const { port, stop } = await startHttpServer({ project, idleTimeoutSec: 900 });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { ok: boolean; pid: number };
      expect(body.ok).toBe(true);

      const client = new Client(
        { name: 'noir-test', version: '0.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
      );
      const result = await client.callTool({ name: 'host_status', arguments: {} });
      const block = result.content?.[0];
      const parsed = JSON.parse((block as { text: string }).text);
      expect(parsed.transport).toBe('streamable-http');
      expect(parsed.daemon).toBe(true);
      expect(typeof parsed.pid).toBe('number');
      await client.close();
    } finally {
      await stop();
      clearProjectDaemonRecord(project.id);
    }
  }, 20000);
});
