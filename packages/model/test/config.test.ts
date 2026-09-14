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

  it('passes authTokenEnv + timeoutMs through as config (NAME only, never the value)', async () => {
    // `authTokenEnv` is threaded as the env-var NAME, exactly like `apiKeyEnv`;
    // the token VALUE is read at call time by `complete()`, never materialized
    // by this mapper (which resolves only the apiKey value). `timeoutMs` is a
    // plain passthrough. Setting the env var must NOT leak the value into the
    // resolved config.
    await withEnv('ANTHROPIC_AUTH_TOKEN', 'tk-secret-bearer', async () => {
      const r = resolveModelConfig({
        providers: {
          anthropic: {
            model: 'claude-haiku',
            authTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
            timeoutMs: 30_000,
          },
        },
      });
      const p = r.providers.anthropic;
      expect(p?.authTokenEnv).toBe('ANTHROPIC_AUTH_TOKEN');
      expect(p?.timeoutMs).toBe(30_000);
      expect(Object.keys(p ?? {})).not.toContain('authToken'); // value stays in env
    });
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

  it('reports hasKey=true for a token-only provider when its token env var is set', async () => {
    await withEnv('NOIR_TEST_TOKEN', 'tk-bearer', async () => {
      const r = resolveModelConfig({
        providers: { anthropic: { model: 'claude-haiku', authTokenEnv: 'NOIR_TEST_TOKEN' } },
      });
      const p = r.providers.anthropic;
      expect(p?.hasKey).toBe(true);
      expect(p?.apiKey).toBeUndefined(); // no apiKeyEnv ⇒ no key resolved
      expect(p?.authTokenEnv).toBe('NOIR_TEST_TOKEN'); // NAME only, never the value
      expect(Object.keys(p ?? {})).not.toContain('authToken'); // value stays in env
    });
  });

  it('reports hasKey=false for a token-only provider whose token env var is unset', async () => {
    await withEnv('NOIR_TEST_MISSING_TOKEN', undefined, async () => {
      const r = resolveModelConfig({
        providers: {
          anthropic: { model: 'claude-haiku', authTokenEnv: 'NOIR_TEST_MISSING_TOKEN' },
        },
      });
      const p = r.providers.anthropic;
      // A token-only provider with its env var unset is NOT ready — the model
      // layer would degrade to null, so doctor must surface the miss.
      expect(p?.hasKey).toBe(false);
      expect(p?.authTokenEnv).toBe('NOIR_TEST_MISSING_TOKEN');
    });
  });

  it('reports hasKey=true when at least one of two named credentials resolves', async () => {
    await withEnv('NOIR_TEST_MISSING_KEY', undefined, async () => {
      await withEnv('NOIR_TEST_TOKEN', 'tk-only', async () => {
        const r = resolveModelConfig({
          providers: {
            anthropic: {
              model: 'claude-haiku',
              apiKeyEnv: 'NOIR_TEST_MISSING_KEY',
              authTokenEnv: 'NOIR_TEST_TOKEN',
            },
          },
        });
        expect(r.providers.anthropic?.hasKey).toBe(true);
        expect(r.providers.anthropic?.apiKey).toBeUndefined();
      });
    });
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
        providers: {
          anthropic: {
            model: 'claude-haiku',
            apiKeyEnv: 'NOIR_TEST_COMPAT',
            authTokenEnv: 'NOIR_TEST_AUTH_TOKEN',
            timeoutMs: 20_000,
          },
        },
      });
      // This assignment is the contract: complete(req, cfg: ModelConfig) accepts it.
      const asModelConfig: ModelConfig = resolved;
      expect(asModelConfig.defaultProvider).toBe('anthropic');
      expect(asModelConfig.providers?.anthropic?.apiKeyEnv).toBe('NOIR_TEST_COMPAT');
      // The transport fields survive the assignment too — an adapter reading
      // them off `ProviderConfig` sees what the user configured.
      expect(asModelConfig.providers?.anthropic?.authTokenEnv).toBe('NOIR_TEST_AUTH_TOKEN');
      expect(asModelConfig.providers?.anthropic?.timeoutMs).toBe(20_000);
    });
  });
});

// Isolate env state so order-independent runs don't bleed NOIR_TEST_* vars.
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('NOIR_TEST_')) delete process.env[k];
  }
});
