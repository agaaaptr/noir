// Slice S-T2 — `noir create` behavior tests.
//
// Drives the REAL `commands/create.ts` (no mock) against a fresh temp dir so
// the engine delegation, dir-creation, transport handling, and skills emission
// are covered end-to-end. The bin-level argv→action wiring is covered in
// bin.test.ts (create mocked at the boundary).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, paths, RULES_BLOCK } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '../src/commands/create.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-create-'));
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('noir create <dir>', () => {
  it('creates the target dir if absent and scaffolds the AI layer into it', async () => {
    const target = join(tmp, 'fresh-app');
    expect(existsSync(target)).toBe(false);

    await create(target, { transport: 'stdio' });

    // The dir was created.
    expect(existsSync(target)).toBe(true);
    // First-run AI-layer artifacts (same set `noir init` produces).
    expect(existsSync(paths.projectId(target))).toBe(true);
    expect(existsSync(paths.config(target))).toBe(true);
    expect(existsSync(paths.noirMd(target))).toBe(true);
    expect(existsSync(paths.rulesMd(target))).toBe(true);

    // .mcp.json reflects the stdio transport.
    const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });

    // CLAUDE.md managed blocks are present.
    const claudeMd = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(CONTEXT_BLOCK_BEGIN);
    expect(claudeMd).toContain(RULES_BLOCK.begin);
    expect(claudeMd).toContain('@import ".noir/NOIR.md"');

    // A scaffold-version stamp is written on create (engine-owned).
    const { readScaffoldVersion } = await import('@noir-ai/create');
    expect(readScaffoldVersion(target)).not.toBeNull();

    // Skills emission (out-of-manifest, composed after scaffold()).
    expect(existsSync(join(target, '.claude', 'skills'))).toBe(true);
  });

  it('emits a streamable-http .mcp.json when transport+url are given', async () => {
    const target = join(tmp, 'http-app');
    await create(target, {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:4321/mcp',
    });
    const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });

  it('rejects streamable-http without --url (plain Error, parity with init — M2)', async () => {
    const target = join(tmp, 'no-url');
    await expect(create(target, { transport: 'streamable-http' })).rejects.toThrow(
      /requires --url/,
    );
    // Nothing was written — the precondition runs before scaffold().
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a non-localhost --url (security gate parity with init)', async () => {
    const target = join(tmp, 'bad-url');
    await expect(
      create(target, { transport: 'streamable-http', url: 'http://evil.com/mcp' }),
    ).rejects.toThrow('Only localhost URLs are supported (got evil.com)');
    expect(existsSync(target)).toBe(false);
  });
});
