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
});
