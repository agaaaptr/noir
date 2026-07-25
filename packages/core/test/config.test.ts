import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies defaults for a minimal config', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.host).toBe('claude');
    expect(cfg.mode).toBe('full');
    expect(cfg.daemon.idleTimeoutSec).toBe(900);
    expect(cfg.daemon.port).toBeUndefined();
  });
  it('accepts a full config', () => {
    const cfg = parseConfig({
      host: 'claude',
      mode: 'quick',
      daemon: { idleTimeoutSec: 60, port: 4321 },
    });
    expect(cfg.mode).toBe('quick');
    expect(cfg.daemon.port).toBe(4321);
  });
  it('rejects an unknown host', () => {
    expect(() => parseConfig({ host: 'gemini' })).toThrow();
  });

  // Slice S6 `context:` block (AC-7 / NFR-6): a config with NO context block
  // parses and defaults to local-embedder-attempted; an explicit block
  // round-trips. The embedder shape is `kind`-based, matching the discriminated
  // EmbedderConfig @noir-ai/context's factory consumes.
  it('defaults the context block to local embeddings when absent', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.context.embedder.kind).toBe('local');
    expect(cfg.context.embedder.dim).toBe(384);
    expect(cfg.context.embedder.model).toBeUndefined();
    expect(cfg.context.roots).toEqual([]);
    expect(cfg.context.budgetTokens).toBe(4096);
  });

  it('accepts an explicit context block and preserves provider-specific fields', () => {
    const cfg = parseConfig({
      host: 'claude',
      context: {
        roots: ['src', 'docs'],
        budgetTokens: 2048,
        embedder: { kind: 'remote', provider: 'openai', model: 'text-embedding-3-small', dim: 384 },
      },
    });
    expect(cfg.context.embedder.kind).toBe('remote');
    expect(cfg.context.embedder.provider).toBe('openai');
    expect(cfg.context.embedder.model).toBe('text-embedding-3-small');
    expect(cfg.context.roots).toEqual(['src', 'docs']);
    expect(cfg.context.budgetTokens).toBe(2048);
  });

  it('applies embedder defaults for a partial context block', () => {
    const cfg = parseConfig({ host: 'claude', context: { embedder: { kind: 'none' } } });
    expect(cfg.context.embedder.kind).toBe('none');
    expect(cfg.context.embedder.dim).toBe(384);
    expect(cfg.context.roots).toEqual([]);
  });

  it('rejects an unknown embedder kind', () => {
    expect(() =>
      parseConfig({ host: 'claude', context: { embedder: { kind: 'voyage' } } }),
    ).toThrow();
  });

  // Slice S8 `model:` block (blueprint D5): a config with NO model block parses
  // to `{}` and degrades every `complete()` call to `null` (offline, free, the
  // default). An explicit block round-trips; `apiKeyEnv` carries the env-var
  // NAME only (DS-8 — never the value). Inner fields are `.optional()` so a
  // present-but-empty block also degrades cleanly.
  it('defaults the model block to an empty object when absent (full degradation)', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.model).toEqual({});
    expect(cfg.model.defaultProvider).toBeUndefined();
    expect(cfg.model.providers).toBeUndefined();
    expect(cfg.model.tiers).toBeUndefined();
  });

  it('accepts an explicit model block and round-trips provider + tier fields', () => {
    const cfg = parseConfig({
      host: 'claude',
      model: {
        defaultProvider: 'anthropic',
        tiers: {
          draft: 'anthropic',
          consolidate: 'openai',
        },
        providers: {
          anthropic: { model: 'claude-haiku', apiKeyEnv: 'ANTHROPIC_API_KEY' },
          ollama: { model: 'llama3.1', baseURL: 'http://localhost:11434/v1' },
        },
      },
    });
    expect(cfg.model.defaultProvider).toBe('anthropic');
    expect(cfg.model.tiers?.draft).toBe('anthropic');
    expect(cfg.model.tiers?.consolidate).toBe('openai');
    // Keyed provider: model required, apiKeyEnv is the NAME (never the value).
    expect(cfg.model.providers?.anthropic).toEqual({
      model: 'claude-haiku',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });
    // Anonymous local provider: no apiKeyEnv, baseURL for the openai-compat path.
    expect(cfg.model.providers?.ollama).toEqual({
      model: 'llama3.1',
      baseURL: 'http://localhost:11434/v1',
    });
  });

  it('treats a present-but-empty model block as full degradation', () => {
    const cfg = parseConfig({ host: 'claude', model: {} });
    expect(cfg.model).toEqual({});
  });

  it('rejects a provider block missing the required model id', () => {
    expect(() =>
      parseConfig({
        host: 'claude',
        model: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
      }),
    ).toThrow();
  });

  // Slice S7 `memory:` block (blueprint D6 / DS-6): a config with NO memory
  // block parses to consolidation-disabled (capture/store/retrieve are always
  // local + free; consolidation is the ONLY LLM touch and it is opt-in +
  // provider-explicit — refuse + log if no provider, NEVER a silent paid call).
  // Mirrors the `daemon` idiom: the outer default matches the parsed output
  // shape so an absent `memory:` block still resolves to a normalized object.
  it('defaults the memory block to consolidation-disabled when absent', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.memory.consolidation.enabled).toBe(false);
    expect(cfg.memory.consolidation.provider).toBeUndefined();
    expect(cfg.memory.consolidation.model).toBeUndefined();
    expect(cfg.memory.consolidation.types).toBeUndefined();
  });

  it('accepts an explicit memory block and round-trips consolidation fields', () => {
    const cfg = parseConfig({
      host: 'claude',
      memory: {
        consolidation: {
          enabled: true,
          provider: 'anthropic',
          model: 'claude-haiku',
          types: ['pattern', 'decision'],
        },
      },
    });
    expect(cfg.memory.consolidation.enabled).toBe(true);
    expect(cfg.memory.consolidation.provider).toBe('anthropic');
    expect(cfg.memory.consolidation.model).toBe('claude-haiku');
    expect(cfg.memory.consolidation.types).toEqual(['pattern', 'decision']);
  });

  it('applies the enabled default for a partial consolidation block', () => {
    // A consolidation block with only provider/model written still defaults
    // `enabled` to false — the master switch is opt-in (DS-6).
    const cfg = parseConfig({
      host: 'claude',
      memory: { consolidation: { provider: 'anthropic', model: 'claude-haiku' } },
    });
    expect(cfg.memory.consolidation.enabled).toBe(false);
    expect(cfg.memory.consolidation.provider).toBe('anthropic');
  });

  it('treats a present-but-empty memory block as consolidation-disabled', () => {
    const cfg = parseConfig({ host: 'claude', memory: {} });
    expect(cfg.memory.consolidation.enabled).toBe(false);
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(() =>
      parseConfig({ host: 'claude', memory: { consolidation: { enabled: 'yes' } } }),
    ).toThrow();
  });
});

describe('parseConfig — Slice X integrations block', () => {
  it('defaults the integrations block to empty (no integrations wired)', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.integrations).toEqual({});
  });

  it('accepts an integration overlay with teamId/listId + runtime', () => {
    const cfg = parseConfig({
      host: 'claude',
      integrations: {
        clickup: { runtime: 'gated-write-proxy', teamId: '90125', listId: 'list42' },
      },
    });
    expect(cfg.integrations.clickup?.runtime).toBe('gated-write-proxy');
    expect(cfg.integrations.clickup?.teamId).toBe('90125');
    expect(cfg.integrations.clickup?.listId).toBe('list42');
  });

  it('defaults runtime to "none" (the safest tier — skill-side reads only)', () => {
    const cfg = parseConfig({
      host: 'claude',
      integrations: { clickup: { listId: 'list42' } },
    });
    expect(cfg.integrations.clickup?.runtime).toBe('none');
  });

  it('accepts a non-empty auth.tokenEnv override', () => {
    const cfg = parseConfig({
      host: 'claude',
      integrations: { clickup: { auth: { tokenEnv: 'CLICKUP_TOKEN_OVERRIDE' } } },
    });
    expect(cfg.integrations.clickup?.auth?.tokenEnv).toBe('CLICKUP_TOKEN_OVERRIDE');
  });

  it('M3: rejects an EMPTY auth.tokenEnv override (matches the declaration schema invariant)', () => {
    // An empty-string override would silently disable the integration
    // (`env['']` is always undefined) instead of failing loudly. The declaration
    // schema enforces `tokenEnv: z.string().min(1)`; the user config overlay must
    // match so a misconfigured empty override fails validation at config load.
    expect(() =>
      parseConfig({
        host: 'claude',
        integrations: { clickup: { auth: { tokenEnv: '' } } },
      }),
    ).toThrow();
  });
});
