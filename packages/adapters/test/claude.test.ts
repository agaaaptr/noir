import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/claude.js';

describe('claudeAdapter', () => {
  const ctx = { root: '/tmp/demo' };

  it('emits a stdio .mcp.json that spawns `noir mcp serve --stdio`', () => {
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(json.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });

  it('emits an http .mcp.json with the given url', () => {
    const json = JSON.parse(
      claudeAdapter.emitMcpConfig(ctx, {
        transport: 'streamable-http',
        url: 'http://127.0.0.1:4321/mcp',
      }),
    );
    expect(json.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });

  it('http without explicit url uses a placeholder to be edited', () => {
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http' }));
    expect(json.mcpServers.noir.type).toBe('http');
    expect(json.mcpServers.noir.url).toMatch(/^http:\/\/127\.0\.0\.1/);
  });

  it('emits a CLAUDE.md @import block wrapped in markers', () => {
    const block = claudeAdapter.emitContext(ctx);
    expect(block).toContain(CONTEXT_BLOCK_BEGIN);
    expect(block).toContain(CONTEXT_BLOCK_END);
    expect(block).toContain('@import ".noir/NOIR.md"');
  });

  it('targets .claude/skills for skill emission', () => {
    expect(claudeAdapter.skillsDir?.({ root: '/p' })).toBe('/p/.claude/skills');
  });
});
