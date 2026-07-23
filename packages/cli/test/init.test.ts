import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, paths } from '@noir-ai/core'; // CONTEXT_BLOCK_BEGIN re-exported below; see note
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-cli-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('init', () => {
  it('scaffolds .noir/ and root .mcp.json + CLAUDE.md', async () => {
    await init(root, { transport: 'stdio' });

    expect(existsSync(paths.noirMd(root))).toBe(true);
    expect(existsSync(paths.config(root))).toBe(true);
    expect(existsSync(paths.projectId(root))).toBe(true);

    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });

    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(CONTEXT_BLOCK_BEGIN);
    expect(claudeMd).toContain('@import ".noir/NOIR.md"');
  });
});
