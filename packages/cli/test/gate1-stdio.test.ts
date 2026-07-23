import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

// `node --import tsx` resolves the `tsx` bare specifier relative to the child's cwd.
// The Gate 1 server runs in an isolated temp dir that has no node_modules, so we
// resolve tsx's loader to an absolute file URL up front (relative to this test
// file, whose location can see the workspace's hoisted tsx) and pass that to
// `--import`. This keeps the brief's `node --import tsx BIN` spawn shape while
// making it independent of the spawned child's working directory.
const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;

describe('Gate 1 — stdio round-trip', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'noir-gate1-'));
    execFileSync(process.execPath, ['--import', TSX_LOADER, BIN, 'init'], { cwd, stdio: 'ignore' });
  }, 20000);

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('noir.host_status returns transport=stdio over stdio', async () => {
    const client = new Client(
      { name: 'noir-test', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', TSX_LOADER, BIN, 'mcp', 'serve', '--stdio'],
      cwd,
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'host_status', arguments: {} });
      const content = result.content?.[0] as { text: string } | undefined;
      const parsed = JSON.parse(content?.text ?? '');
      expect(parsed.transport).toBe('stdio');
      expect(parsed.daemon).toBe(false);
      expect(parsed.host).toBe('claude');
      expect(parsed.project.id.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 20000);
});
