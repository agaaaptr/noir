import { afterEach, describe, expect, it } from 'vitest';
import { resolveModelConfig } from '../src/config.js';
import type { ModelConfig, ResolvedModelConfig } from '../src/index.js';

// resolveModelConfig reads process.env to materialize API-key VALUES; each case
// that touches an env var restores it. Mirrors the withEnv helper in
// complete.test.ts (kept local so both test files stay self-contained).
function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

describe('resolveModelConfig — degradation + passthrough', () => {
  it('returns an empty resolved config when raw is undefined (full degradation)', () => {
    const r = resolveModelConfig(undefined);
    expect(r.defaultProvider).toBeUndefined();
    expect(r.tiers).toEqual({});
    expect(r.providers).toEqual({});
  });

  it('returns an empty resolved config when the model block is empty', () => {
    const r = resolveModelConfig({});
    expect(r.tiers).toEqual({});
    expect(r.providers).toEqual({});
    expect(r.defaultProvider).toBeUndefined();
  });

  it('passes defaultProvider and tier overrides through unchanged', () => {
    const r = resolveModelConfig({
      defaultProvider: 'anthropic',
      tiers: { draft: 'anthropic', consolidate: 'openai' },
    });
    expect(r.defaultProvider).toBe('anthropic');
    expect(r.tiers.draft).toBe('anthropic');
    expect(r.tiers.consolidate).toBe('openai');
    expect(r.tiers.title).toBeUndefined();
  });

  it('normalizes an absent tiers object to {} (no undefined to check at the call site)', () => {
    const r = resolveModelConfig({ defaultProvider: 'x' });
    expect(r.tiers).toEqual({});
  });
});

describe('resolveModelConfig — key resolution from env', () => {
  it('materializes the key VALUE from process.env[apiKeyEnv] for a keyed provider', async () => {
    await withEnv('NOIR_TEST_MODEL_KEY', 'sk-resolved-secret', async () => {
      const r = resolveModelConfig({
        providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_MODEL_KEY' } },
      });
      const p = r.providers.anthropic;
      expect(p).toBeDefined();
      // VALUE resolved from env:
      expect(p?.apiKey).toBe('sk-resolved-secret');
      // NAME passthrough (doctor prints this, never the value):
      expect(p?.apiKeyEnv).toBe('NOIR_TEST_MODEL_KEY');
      expect(p?.model).toBe('claude-haiku');
      expect(p?.hasKey).toBe(true);
    });
  });

  it('reports hasKey=false when a keyed provider env var is missing', async () => {
    await withEnv('NOIR_TEST_MISSING_KEY', undefined, async () => {
      const r = resolveModelConfig({
        providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_MISSING_KEY' } },
      });
      const p = r.providers.anthropic;
      expect(p?.apiKey).toBeUndefined();
      expect(p?.hasKey).toBe(false);
      // The NAME is still carried (doctor can name the missing var):
      expect(p?.apiKeyEnv).toBe('NOIR_TEST_MISSING_KEY');
    });
  });

  it('treats an anonymous provider (no apiKeyEnv) as ready — hasKey true, no key needed', () => {
    // Local Ollama / LM Studio: omit apiKeyEnv entirely; the openai-compatible
    // adapter then sends no auth header. hasKey is vacuously true.
    const r = resolveModelConfig({
      providers: { ollama: { model: 'llama3.1', baseURL: 'http://localhost:11434/v1' } },
    });
    const p = r.providers.ollama;
    expect(p?.apiKey).toBeUndefined();
    expect(p?.apiKeyEnv).toBeUndefined();
    expect(p?.hasKey).toBe(true);
    expect(p?.baseURL).toBe('http://localhost:11434/v1');
  });

  it('never mutates the input or process.env', async () => {
    const raw = {
      providers: { openai: { model: 'gpt-4o-mini', apiKeyEnv: 'NOIR_TEST_IMMUT' } },
    };
    await withEnv('NOIR_TEST_IMMUT', 'sk-x', async () => {
      const snapshot = { ...raw.providers.openai };
      resolveModelConfig(raw);
      expect(raw.providers.openai).toEqual(snapshot); // input untouched
      expect(process.env.NOIR_TEST_IMMUT).toBe('sk-x'); // env untouched
    });
  });
});

describe('resolveModelConfig — provider-EXPLICIT, never inferred', () => {
  it('does not add providers that the user did not write, even when their env var is set', async () => {
    // ANTHROPIC_API_KEY may be set in the host env for another tool. The bridge
    // MUST NOT invent an `anthropic` provider from its presence — it maps only
    // what the user explicitly configured (here: only `openai`).
    await withEnv('ANTHROPIC_API_KEY', 'sk-from-another-tool', async () => {
      const r = resolveModelConfig({
        providers: { openai: { model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' } },
      });
      expect(Object.keys(r.providers)).toEqual(['openai']);
      expect(r.providers.anthropic).toBeUndefined();
      expect(r.defaultProvider).toBeUndefined();
    });
  });

  it('is a pure projection — the provider set depends only on the config, not the env', async () => {
    const cfg = { providers: { a: { model: 'm', apiKeyEnv: 'NOIR_A' } } };
    await withEnv('NOIR_A', undefined, async () => {
      const withoutKey = resolveModelConfig(cfg);
      await withEnv('NOIR_A', 'sk-a', async () => {
        const withKey = resolveModelConfig(cfg);
        // Same provider SET; only the resolved key / hasKey differ.
        expect(Object.keys(withoutKey.providers)).toEqual(['a']);
        expect(Object.keys(withKey.providers)).toEqual(['a']);
        expect(withoutKey.providers.a?.hasKey).toBe(false);
        expect(withKey.providers.a?.hasKey).toBe(true);
      });
    });
  });
});

describe('resolveModelConfig — structural compatibility with complete()', () => {
  it('a ResolvedModelConfig is assignable to ModelConfig (drops into complete(req, cfg))', async () => {
    // Type-level assertion: the resolved shape is a STRUCTURAL SUPERSET of the
    // runtime ModelConfig complete() consumes (every ProviderConfig field is
    // present; extra apiKey/hasKey are ignored). If this stops compiling, the
    // bridge can no longer feed complete() without an adapter — a regression.
    await withEnv('NOIR_TEST_COMPAT', 'sk-y', async () => {
      const resolved: ResolvedModelConfig = resolveModelConfig({
        defaultProvider: 'anthropic',
        providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_COMPAT' } },
      });
      // This assignment is the contract: complete(req, cfg: ModelConfig) accepts it.
      const asModelConfig: ModelConfig = resolved;
      expect(asModelConfig.defaultProvider).toBe('anthropic');
      expect(asModelConfig.providers?.anthropic?.apiKeyEnv).toBe('NOIR_TEST_COMPAT');
    });
  });
});

// Isolate env state so order-independent runs don't bleed NOIR_TEST_* vars.
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('NOIR_TEST_')) delete process.env[k];
  }
});
