import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/claude.js';
import type { IntegrationMcpEmission } from '../src/types.js';

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

  it('emits a rules @import block wrapped in markers', () => {
    const block = claudeAdapter.emitRules?.(ctx) ?? '';
    expect(block).toContain(RULES_BLOCK.begin);
    expect(block).toContain(RULES_BLOCK.end);
    expect(block).toContain('@import ".noir/rules/RULES.md"');
  });
});

// ---------------------------------------------------------------------------
// PARITY GATE — the claude surface is the regression anchor for `noir init`.
// Slice E grows the init output (.noir/README.md, .noir/.env) and drops three
// vestigial ignore entries, but it may not move a byte of what CLAUDE.md and
// .mcp.json contain. These literals are byte-frozen on purpose: any drift in
// the adapter (or in the templates that must render to the same bytes) fails
// here rather than silently in a user's repo.
// ---------------------------------------------------------------------------
describe('claudeAdapter — byte-frozen emission (noir init regression anchor)', () => {
  const ctx = { root: '/tmp/demo' };

  it('emitContext() output is byte-frozen', () => {
    expect(claudeAdapter.emitContext(ctx)).toBe(
      '<!-- noir:context begin -->\n@import ".noir/NOIR.md"\n<!-- noir:context end -->\n',
    );
  });

  it('emitRules() output is byte-frozen', () => {
    expect(claudeAdapter.emitRules?.(ctx)).toBe(
      '<!-- noir:rules begin -->\n@import ".noir/rules/RULES.md"\n<!-- noir:rules end -->\n',
    );
  });

  it('emitMcpConfig() (stdio) output is byte-frozen', () => {
    expect(claudeAdapter.emitMcpConfig(ctx, { transport: 'stdio' })).toBe(
      '{\n  "mcpServers": {\n    "noir": {\n      "command": "noir",\n      "args": [\n        "mcp",\n        "serve",\n        "--stdio"\n      ]\n    }\n  }\n}',
    );
  });
});

describe('claudeAdapter.emitMcpConfig — Slice X integration overload', () => {
  const ctx = { root: '/tmp/demo' };

  it('two-arg form still works (backward-compatible — no integration entry)', () => {
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(Object.keys(json.mcpServers)).toEqual(['noir']);
  });

  it('merges an external-mcp stdio server alongside the noir entry', () => {
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-github',
      command: 'noir-integration-github',
      args: ['serve'],
      transport: 'stdio',
    };
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }, integration));
    expect(json.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
    expect(json.mcpServers['noir-github']).toEqual({
      command: 'noir-integration-github',
      args: ['serve'],
    });
  });

  it('merges an external-mcp http server entry', () => {
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
    };
    const json = JSON.parse(
      claudeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http' }, integration),
    );
    expect(json.mcpServers['noir-linear']).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/sse',
    });
  });

  it('forwards env when the integration declares it', () => {
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-github',
      command: 'noir-integration-github',
      transport: 'stdio',
      env: { GITHUB_TOKEN_ENV: 'GH_TOKEN' },
    };
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }, integration));
    expect(json.mcpServers['noir-github'].env).toEqual({ GITHUB_TOKEN_ENV: 'GH_TOKEN' });
  });

  it('M2: http transport nests env under `env:` (NOT spread at the entry top level)', () => {
    // Latent today (no external-mcp ships over http) but lock it: the http
    // branch MUST nest env under `env:` like the stdio branch does, not spread
    // env keys as top-level server fields (which would corrupt the entry shape).
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      env: { LINEAR_TOKEN_ENV: 'LINEAR_API_KEY' },
    };
    const json = JSON.parse(
      claudeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http' }, integration),
    );
    const entry = json.mcpServers['noir-linear'];
    expect(entry.env).toEqual({ LINEAR_TOKEN_ENV: 'LINEAR_API_KEY' });
    // The env key is NOT promoted to a top-level server field (the bug shape).
    expect(entry.LINEAR_TOKEN_ENV).toBeUndefined();
    // Sanity: the entry still carries type + url.
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('https://mcp.linear.app/sse');
  });
});
