import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import { emitAgentsMd } from '../src/agents-md.js';
import { agentsMdAdapter } from '../src/agents-md-adapter.js';
import { claudeAdapter } from '../src/claude.js';
import { cursorAdapter } from '../src/cursor.js';
import { geminiAdapter } from '../src/gemini.js';
import { resolveAdapter } from '../src/index.js';
import { buildMcpServersJson } from '../src/mcp.js';
import { opencodeAdapter } from '../src/opencode.js';
import type { EmitContext, HostAdapter, IntegrationMcpEmission } from '../src/types.js';

const ctx: EmitContext = { root: '/tmp/demo' };

// ---------------------------------------------------------------------------
// Shared emission invariant — adapters whose `emitContext` IS the universal
// AGENTS.md (agents-md / cursor / opencode) produce BYTE-IDENTICAL content.
// Gemini is EXCLUDED here — like claude, its `emitContext` returns its NATIVE
// context (GEMINI.md); the universal AGENTS.md is composed SEPARATELY by the
// cli via the same `emitAgentsMd` helper (identical by construction), so it is
// not asserted through `emitContext`. Claude is excluded for the same reason.
// ---------------------------------------------------------------------------
describe('AGENTS.md parity — adapters whose emitContext IS the AGENTS.md', () => {
  const agentsMdHosts: HostAdapter[] = [agentsMdAdapter, cursorAdapter, opencodeAdapter];

  it('every agents-md-composing adapter emits the canonical AGENTS.md content', () => {
    const expected = emitAgentsMd(ctx);
    for (const adapter of agentsMdHosts) {
      expect(adapter.emitContext(ctx)).toBe(expected);
    }
  });

  it('the AGENTS.md content carries both @-imports (NOIR.md + RULES.md)', () => {
    for (const adapter of agentsMdHosts) {
      const md = adapter.emitContext(ctx);
      expect(md).toContain('@.noir/NOIR.md');
      expect(md).toContain('@.noir/rules/RULES.md');
    }
  });

  it.each([
    ['agents-md', agentsMdAdapter],
    ['gemini', geminiAdapter],
    ['cursor', cursorAdapter],
    ['opencode', opencodeAdapter],
  ] as const)('%s resolves via resolveAdapter and is the same instance', (id, adapter) => {
    expect(resolveAdapter(id)).toBe(adapter);
  });
});

// ---------------------------------------------------------------------------
// Per-adapter emission contracts.
// ---------------------------------------------------------------------------

describe('agents-md adapter (the universal minimal)', () => {
  it('id is "agents-md"', () => {
    expect(agentsMdAdapter.id).toBe('agents-md');
  });

  it('emitContext returns the universal AGENTS.md content', () => {
    expect(agentsMdAdapter.emitContext(ctx)).toBe(emitAgentsMd(ctx));
  });

  it('has NO emitRules (rules live in AGENTS.md)', () => {
    expect(agentsMdAdapter.emitRules).toBeUndefined();
  });

  it('has NO skillsDir (no skill concept)', () => {
    expect(agentsMdAdapter.skillsDir).toBeUndefined();
  });

  it('mcpConfigPath is workspace .mcp.json', () => {
    expect(agentsMdAdapter.mcpConfigPath?.(ctx)).toBe('/tmp/demo/.mcp.json');
  });

  it('agentsMdPath is root AGENTS.md', () => {
    expect(agentsMdAdapter.agentsMdPath?.(ctx)).toBe('/tmp/demo/AGENTS.md');
  });

  it('emitMcpConfig returns the {mcpServers} shape with the noir entry', () => {
    const json = JSON.parse(agentsMdAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(json.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });
});

describe('gemini adapter', () => {
  it('id is "gemini"', () => {
    expect(geminiAdapter.id).toBe('gemini');
  });

  it('emitContext produces GEMINI.md with context + rules blocks (rules folded in)', () => {
    const md = geminiAdapter.emitContext(ctx);
    // Both managed-block markers present (user content survives sync).
    expect(md).toContain(CONTEXT_BLOCK_BEGIN);
    expect(md).toContain(CONTEXT_BLOCK_END);
    expect(md).toContain(RULES_BLOCK.begin);
    expect(md).toContain(RULES_BLOCK.end);
    // Gemini @file imports — bare `@.noir/...` (NO `@import`, NO quotes).
    expect(md).toContain('@.noir/NOIR.md');
    expect(md).toContain('@.noir/rules/RULES.md');
    expect(md).not.toContain('@import');
    expect(md).not.toContain('"');
  });

  it('emitContext places the context block before the rules block', () => {
    const md = geminiAdapter.emitContext(ctx);
    const ctxIdx = md.indexOf(CONTEXT_BLOCK_BEGIN);
    const rulesIdx = md.indexOf(RULES_BLOCK.begin);
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(ctxIdx);
  });

  it('has NO emitRules (folded into emitContext — GEMINI.md carries both)', () => {
    expect(geminiAdapter.emitRules).toBeUndefined();
  });

  it('has NO skillsDir', () => {
    expect(geminiAdapter.skillsDir).toBeUndefined();
  });

  it('mcpConfigPath is workspace .gemini/mcp.json', () => {
    expect(geminiAdapter.mcpConfigPath?.(ctx)).toBe('/tmp/demo/.gemini/mcp.json');
  });

  it('agentsMdPath is root AGENTS.md (cli also emits AGENTS.md for gemini)', () => {
    expect(geminiAdapter.agentsMdPath?.(ctx)).toBe('/tmp/demo/AGENTS.md');
  });

  it('emitMcpConfig returns the {mcpServers} shape', () => {
    const json = JSON.parse(geminiAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(json.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });
});

describe('cursor adapter', () => {
  it('id is "cursor"', () => {
    expect(cursorAdapter.id).toBe('cursor');
  });

  it('emitContext returns the universal AGENTS.md content (cursor reads AGENTS.md)', () => {
    expect(cursorAdapter.emitContext(ctx)).toBe(emitAgentsMd(ctx));
  });

  it('has NO emitRules (cursor rules are delivered via AGENTS.md — no separate host-rules .mdc)', () => {
    // The prior `noir-contract.mdc` host-rules pointer was REMOVED: it
    // collided with the cursor flat-skill prune of `noir-*.mdc` under
    // `.cursor/rules/`. Cursor's rules now come via AGENTS.md's
    // `@.noir/rules/RULES.md` import (same universal surface as agents-md/
    // opencode), so the cursor adapter no longer owns a rules emission.
    expect(cursorAdapter.emitRules).toBeUndefined();
  });

  it('skillsDir is .cursor/rules (skills compile to .mdc here)', () => {
    expect(cursorAdapter.skillsDir?.(ctx)).toBe('/tmp/demo/.cursor/rules');
  });

  it('mcpConfigPath is workspace .cursor/mcp.json', () => {
    expect(cursorAdapter.mcpConfigPath?.(ctx)).toBe('/tmp/demo/.cursor/mcp.json');
  });

  it('agentsMdPath is root AGENTS.md', () => {
    expect(cursorAdapter.agentsMdPath?.(ctx)).toBe('/tmp/demo/AGENTS.md');
  });

  it('emitMcpConfig returns the {mcpServers} shape', () => {
    const json = JSON.parse(cursorAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(json.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });
});

describe('opencode adapter', () => {
  it('id is "opencode"', () => {
    expect(opencodeAdapter.id).toBe('opencode');
  });

  it('emitContext returns the universal AGENTS.md content', () => {
    expect(opencodeAdapter.emitContext(ctx)).toBe(emitAgentsMd(ctx));
  });

  it('has NO emitRules (rules live in AGENTS.md)', () => {
    expect(opencodeAdapter.emitRules).toBeUndefined();
  });

  it('has NO skillsDir', () => {
    expect(opencodeAdapter.skillsDir).toBeUndefined();
  });

  it('mcpConfigPath is workspace opencode.json (NOT .mcp.json)', () => {
    expect(opencodeAdapter.mcpConfigPath?.(ctx)).toBe('/tmp/demo/opencode.json');
  });

  it('agentsMdPath is root AGENTS.md', () => {
    expect(opencodeAdapter.agentsMdPath?.(ctx)).toBe('/tmp/demo/AGENTS.md');
  });

  it('emitMcpConfig (stdio) produces the opencode.json shape: $schema + mcp.local', () => {
    const json = JSON.parse(opencodeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(json.$schema).toBe('https://opencode.ai/config.json');
    // OpenCode stdio entries are `{ type: 'local', command: [...] }` — the
    // command is an ARRAY (not the claude `{command, args}` split). The first
    // element threads opts.command (defaults to 'noir'; absolute native shim
    // when resolveNoirCommand() detects a native install).
    expect(json.mcp.noir).toEqual({
      type: 'local',
      command: ['noir', 'mcp', 'serve', '--stdio'],
    });
    // The claude `{mcpServers}` key is NOT present — different shape entirely.
    expect(json.mcpServers).toBeUndefined();
  });

  it('emitMcpConfig (stdio) honors opts.command (absolute native shim)', () => {
    // Regression guard: opencode used to hardcode 'noir' and silently drop
    // opts.command, so a native install emitted a bare 'noir' that GUI MCP
    // clients (no shell profile PATH) couldn't spawn. All 5 adapters must
    // thread opts.command — see the table-driven parity test below.
    const json = JSON.parse(
      opencodeAdapter.emitMcpConfig(ctx, {
        transport: 'stdio',
        command: '/Users/x/.noir/bin/noir',
      }),
    );
    expect(json.mcp.noir).toEqual({
      type: 'local',
      command: ['/Users/x/.noir/bin/noir', 'mcp', 'serve', '--stdio'],
    });
  });

  it('emitMcpConfig (http) produces {type:"remote", url} — opencode spells it "remote", NOT "http"', () => {
    // Verified against https://opencode.ai/docs/mcp-servers/: "Add remote MCP
    // servers by setting `type` to \"remote\"". The prior `type:'http'` shape
    // was wrong — opencode has no `'http'`/`'sse'` enum value.
    const json = JSON.parse(
      opencodeAdapter.emitMcpConfig(ctx, {
        transport: 'streamable-http',
        url: 'http://127.0.0.1:4321/mcp',
      }),
    );
    expect(json.mcp.noir).toEqual({ type: 'remote', url: 'http://127.0.0.1:4321/mcp' });
  });

  it('emitMcpConfig merges an external-mcp stdio integration under its serverName', () => {
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-github',
      command: 'noir-integration-github',
      args: ['serve'],
      transport: 'stdio',
    };
    const json = JSON.parse(
      opencodeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }, integration),
    );
    expect(json.mcp.noir).toEqual({
      type: 'local',
      command: ['noir', 'mcp', 'serve', '--stdio'],
    });
    // OpenCode merges the integration's command + args into a single array.
    expect(json.mcp['noir-github']).toEqual({
      type: 'local',
      command: ['noir-integration-github', 'serve'],
    });
  });

  it('emitMcpConfig merges an external-mcp http integration (type:"remote")', () => {
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
    };
    const json = JSON.parse(
      opencodeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http' }, integration),
    );
    expect(json.mcp['noir-linear']).toEqual({ type: 'remote', url: 'https://mcp.linear.app/sse' });
  });

  it('opencode env vars land under `environment:` (NOT `env:`) — verified verbatim from opencode docs', () => {
    // Opencode's server entries use the `environment:` key for env vars (the
    // `.mcp.json` / `.cursor/mcp.json` / `.gemini/mcp.json` family keeps `env:`
    // — correct for THOSE hosts; this assertion guards opencode's spelling).
    const stdioWithEnv: IntegrationMcpEmission = {
      serverName: 'noir-github',
      command: 'noir-integration-github',
      args: ['serve'],
      transport: 'stdio',
      env: { GITHUB_TOKEN: 'secret' },
    };
    const stdioJson = JSON.parse(
      opencodeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }, stdioWithEnv),
    );
    expect(stdioJson.mcp['noir-github'].environment).toEqual({ GITHUB_TOKEN: 'secret' });
    expect(stdioJson.mcp['noir-github'].env).toBeUndefined();

    const httpWithEnv: IntegrationMcpEmission = {
      serverName: 'noir-linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      env: { LINEAR_TOKEN: 'secret' },
    };
    const httpJson = JSON.parse(
      opencodeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http' }, httpWithEnv),
    );
    expect(httpJson.mcp['noir-linear'].environment).toEqual({ LINEAR_TOKEN: 'secret' });
    expect(httpJson.mcp['noir-linear'].env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildMcpServersJson — the shared {mcpServers} helper (claude parity anchor).
// ---------------------------------------------------------------------------

describe('buildMcpServersJson — the shared {mcpServers} helper', () => {
  it('claude.emitMcpConfig delegates here (byte-identical output)', () => {
    // The claude adapter MUST produce the same bytes as the shared helper —
    // this is the S10-Adapters refactor's regression anchor (the
    // create/scaffold.test.ts parity gate downstream depends on it).
    const cases = [
      { transport: 'stdio' as const },
      { transport: 'streamable-http' as const, url: 'http://127.0.0.1:4321/mcp' },
    ];
    for (const opts of cases) {
      expect(claudeAdapter.emitMcpConfig(ctx, opts)).toBe(buildMcpServersJson(opts));
    }
  });

  it('byte-identical across every {mcpServers}-shape adapter (claude/agents-md/gemini/cursor)', () => {
    const opts = { transport: 'stdio' as const };
    const expected = buildMcpServersJson(opts);
    expect(agentsMdAdapter.emitMcpConfig(ctx, opts)).toBe(expected);
    expect(geminiAdapter.emitMcpConfig(ctx, opts)).toBe(expected);
    expect(cursorAdapter.emitMcpConfig(ctx, opts)).toBe(expected);
    expect(claudeAdapter.emitMcpConfig(ctx, opts)).toBe(expected);
  });

  it('integration merge parity across {mcpServers}-shape adapters', () => {
    const integration: IntegrationMcpEmission = {
      serverName: 'noir-github',
      command: 'noir-integration-github',
      args: ['serve'],
      transport: 'stdio',
    };
    const opts = { transport: 'stdio' as const };
    const expected = buildMcpServersJson(opts, integration);
    expect(claudeAdapter.emitMcpConfig(ctx, opts, integration)).toBe(expected);
    expect(agentsMdAdapter.emitMcpConfig(ctx, opts, integration)).toBe(expected);
    expect(geminiAdapter.emitMcpConfig(ctx, opts, integration)).toBe(expected);
    expect(cursorAdapter.emitMcpConfig(ctx, opts, integration)).toBe(expected);
  });

  it('opencode does NOT use buildMcpServersJson (different shape)', () => {
    // Sanity: opencode emits its own shape — the {mcpServers} helper output is
    // NOT what opencode produces. This guards against a future refactor
    // accidentally routing opencode through the shared helper.
    const opts = { transport: 'stdio' as const };
    expect(opencodeAdapter.emitMcpConfig(ctx, opts)).not.toBe(buildMcpServersJson(opts));
  });
});

// ---------------------------------------------------------------------------
// Path seams — the four NEW adapters implement mcpConfigPath + agentsMdPath.
// Claude is intentionally EXCLUDED (per the spec: "existing adapters keep
// working unchanged" — claude leaves these optional seams undefined; its MCP
// path stays hardcoded in the cli/create scaffold as before).
// ---------------------------------------------------------------------------

describe('path seams — every new adapter declares its MCP + AGENTS.md paths', () => {
  it.each([
    ['agents-md', agentsMdAdapter, '/tmp/demo/.mcp.json', '/tmp/demo/AGENTS.md'],
    ['gemini', geminiAdapter, '/tmp/demo/.gemini/mcp.json', '/tmp/demo/AGENTS.md'],
    ['cursor', cursorAdapter, '/tmp/demo/.cursor/mcp.json', '/tmp/demo/AGENTS.md'],
    ['opencode', opencodeAdapter, '/tmp/demo/opencode.json', '/tmp/demo/AGENTS.md'],
  ])('%s: mcpConfigPath=%s, agentsMdPath=%s', (_id, adapter, mcpPath, agentsPath) => {
    expect(adapter.mcpConfigPath?.(ctx)).toBe(mcpPath);
    expect(adapter.agentsMdPath?.(ctx)).toBe(agentsPath);
  });

  it('claude leaves the new path seams undefined (existing adapter unchanged)', () => {
    // The S10 spec contract: the new optional seams do NOT retro-fit claude —
    // its `.mcp.json` path stays hardcoded in cli/create (the regression anchor
    // holds: no behavioral surface added).
    expect(claudeAdapter.mcpConfigPath).toBeUndefined();
    expect(claudeAdapter.agentsMdPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MCP command threading — cross-adapter parity contract.
// Every host adapter MUST honor opts.command (the absolute native shim that
// resolveNoirCommand() emits for native installs). opencode used to hardcode
// 'noir' and silently drop it — this table-driven test locks the contract so
// the bug can't silently recur for ANY of the 5 hosts.
// ---------------------------------------------------------------------------

describe('MCP command threading — every adapter honors opts.command', () => {
  // Extract the noir command from whatever shape each host emits. The 4
  // {mcpServers}-shape adapters split command/args; opencode packs them in a
  // single array. Both must surface opts.command as the resolved command.
  function resolvedCommand(json: {
    mcpServers?: { noir?: { command?: unknown } };
    mcp?: { noir?: { command?: unknown[] } };
  }): string | string[] | undefined {
    return json.mcpServers?.noir?.command ?? json.mcp?.noir?.command?.[0];
  }

  it.each([
    ['claude', claudeAdapter],
    ['agents-md', agentsMdAdapter],
    ['gemini', geminiAdapter],
    ['cursor', cursorAdapter],
    ['opencode', opencodeAdapter],
  ])('%s threads an absolute opts.command into the noir entry', (_id, adapter) => {
    const json = JSON.parse(
      adapter.emitMcpConfig(ctx, { transport: 'stdio', command: '/abs/shim/noir' }),
    );
    expect(resolvedCommand(json)).toBe('/abs/shim/noir');
  });

  it.each([
    ['claude', claudeAdapter],
    ['agents-md', agentsMdAdapter],
    ['gemini', geminiAdapter],
    ['cursor', cursorAdapter],
    ['opencode', opencodeAdapter],
  ])('%s defaults to bare "noir" when opts.command is omitted', (_id, adapter) => {
    const json = JSON.parse(adapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(resolvedCommand(json)).toBe('noir');
  });
});
