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
});
