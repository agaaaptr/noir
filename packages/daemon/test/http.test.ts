import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ProjectInfo } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { clearProjectDaemonRecord } from '../src/project-record.js';
import { readDaemonToken, tokenPath } from '../src/token.js';

// Isolate the per-project daemon records per vitest worker (file-parallelism
// safe). `startHttpServer` writes this project's record + token under this dir.
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
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${readDaemonToken(project.id)}` } },
        }),
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

  it('gates /mcp behind the bearer token, leaving /health token-free', async () => {
    clearProjectDaemonRecord(project.id);
    const { port, stop } = await startHttpServer({ project, idleTimeoutSec: 900 });
    const mcp = `http://127.0.0.1:${port}/mcp`;
    const noAuth = { method: 'POST', headers: { 'content-type': 'application/json' } };
    try {
      // The daemon minted a token for this lifecycle, on disk at 0600.
      const token = readDaemonToken(project.id);
      expect(token).not.toBeNull();
      expect(existsSync(tokenPath(project.id))).toBe(true);

      // /health is the probe's dependency: it answers 200 with NO Authorization
      // header at all (its body carries no secret).
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

      // /mcp without a header → 401 with a body naming the remediation.
      const anonymous = await fetch(mcp, { ...noAuth, body: '{}' });
      expect(anonymous.status).toBe(401);
      const body = (await anonymous.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/unauthorized/);
      expect(body.error).toMatch(/noir daemon token/);
      expect(body.error).toMatch(/stdio/);

      // /mcp with the WRONG bearer → still 401 (the token is actually compared).
      const wrong = await fetch(mcp, {
        ...noAuth,
        headers: { ...noAuth.headers, Authorization: 'Bearer not-the-token' },
        body: '{}',
      });
      expect(wrong.status).toBe(401);

      // /mcp with the CORRECT bearer → past the gate (whatever the MCP layer
      // then makes of a bare `{}` body, it is not an auth rejection).
      const withToken = await fetch(mcp, {
        ...noAuth,
        headers: { ...noAuth.headers, Authorization: `Bearer ${token}` },
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
      const parsed = JSON.parse(block?.text ?? '');
      expect(parsed.daemon).toBe(true);
      await client.close();
    } finally {
      await stop();
      clearProjectDaemonRecord(project.id);
    }
  }, 20000);

  it('mints a fresh token per start and clears it on shutdown', async () => {
    clearProjectDaemonRecord(project.id);
    const first = await startHttpServer({ project, idleTimeoutSec: 900 });
    const firstToken = readDaemonToken(project.id);
    expect(firstToken).not.toBeNull();
    await first.stop();
    // Cleared on shutdown: the client's copy cannot outlive the process.
    expect(readDaemonToken(project.id)).toBeNull();
    expect(existsSync(tokenPath(project.id))).toBe(false);

    const second = await startHttpServer({ project, idleTimeoutSec: 900 });
    try {
      expect(readDaemonToken(project.id)).not.toBe(firstToken);
    } finally {
      await second.stop();
      clearProjectDaemonRecord(project.id);
    }
  }, 20000);
});
