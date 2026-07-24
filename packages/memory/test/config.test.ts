import { afterEach, describe, expect, it } from 'vitest';
import { resolveMemoryConfig } from '../src/config.js';
import type { MemoryConfig, MemoryUserConfig } from '../src/index.js';

// resolveMemoryConfig reads NO environment (pure projection — DS-6), but the
// provider-EXPLICIT invariants below set ANTHROPIC_API_KEY to prove the mapper
// ignores it. Each case restores env; withEnv mirrors complete.test.ts's helper
// (kept local so both test files stay self-contained).
function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

describe('resolveMemoryConfig — disabled default + passthrough', () => {
  it('returns a disabled consolidation config when raw is undefined', () => {
    const r = resolveMemoryConfig(undefined);
    expect(r.consolidation).toBeDefined();
    expect(r.consolidation?.enabled).toBe(false);
    expect(r.consolidation?.provider).toBeUndefined();
    expect(r.consolidation?.model).toBeUndefined();
    expect(r.consolidation?.types).toBeUndefined();
  });

  it('returns a disabled consolidation config when the memory block is empty', () => {
    const r = resolveMemoryConfig({});
    expect(r.consolidation?.enabled).toBe(false);
  });

  it('returns a disabled consolidation config when consolidation is absent', () => {
    // A memory block that carries other (future) keys but no consolidation.
    const r = resolveMemoryConfig({} as MemoryUserConfig);
    expect(r.consolidation?.enabled).toBe(false);
  });

  it('treats an explicitly-disabled block as disabled', () => {
    const r = resolveMemoryConfig({ consolidation: { enabled: false } });
    expect(r.consolidation?.enabled).toBe(false);
  });

  it('ignores provider/model when enabled is false (the master switch is gate 0)', () => {
    // runConsolidation checks `enabled` first; even with a provider written, a
    // disabled block must NOT surface as runnable. The resolver still passes the
    // fields through (pure projection) but `enabled:false` governs downstream.
    const r = resolveMemoryConfig({
      consolidation: { enabled: false, provider: 'anthropic', model: 'claude-haiku' },
    });
    expect(r.consolidation?.enabled).toBe(false);
    // Passthrough is faithful (the consumer re-checks enabled, not the resolver):
    expect(r.consolidation?.provider).toBe('anthropic');
    expect(r.consolidation?.model).toBe('claude-haiku');
  });
});

describe('resolveMemoryConfig — enabled block passthrough', () => {
  it('passes provider/model/types through unchanged when enabled', () => {
    const r = resolveMemoryConfig({
      consolidation: {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku',
        types: ['pattern', 'decision'],
      },
    });
    expect(r.consolidation?.enabled).toBe(true);
    expect(r.consolidation?.provider).toBe('anthropic');
    expect(r.consolidation?.model).toBe('claude-haiku');
    expect(r.consolidation?.types).toEqual(['pattern', 'decision']);
  });

  it('passes enabled:true through even with no provider (gate is runConsolidation, not the resolver)', () => {
    // The resolver is a PURE projection — it does not decide whether
    // consolidation CAN run. enabled:true + no provider still surfaces; the
    // no-provider refusal lives in runConsolidation (gate 1), keeping the mapper
    // side-effect-free and the policy in one place.
    const r = resolveMemoryConfig({ consolidation: { enabled: true } });
    expect(r.consolidation?.enabled).toBe(true);
    expect(r.consolidation?.provider).toBeUndefined();
  });

  it('always populates consolidation (no undefined to check at the call site)', () => {
    // Mirrors how resolveModelConfig normalizes tiers/providers to always-present
    // objects: consumers read `config.consolidation.enabled` directly.
    const r = resolveMemoryConfig(undefined);
    expect(r.consolidation).toBeDefined();
    expect(r.consolidation?.enabled).toBe(false);
  });
});

describe('resolveMemoryConfig — provider-EXPLICIT, never inferred (DS-6)', () => {
  it('does not invent a provider from env-var presence', async () => {
    // ANTHROPIC_API_KEY may be set in the host env for another tool. The bridge
    // MUST NOT materialize a `provider` from its presence — it copies ONLY what
    // the user explicitly configured (here: nothing).
    await withEnv('ANTHROPIC_API_KEY', 'sk-from-another-tool', async () => {
      const r = resolveMemoryConfig({ consolidation: { enabled: true } });
      expect(r.consolidation?.provider).toBeUndefined();
    });
  });

  it('is a pure projection — the output depends only on the config, never the env', async () => {
    const cfg: MemoryUserConfig = { consolidation: { enabled: true, provider: 'anthropic' } };
    await withEnv('ANTHROPIC_API_KEY', undefined, async () => {
      const withoutKey = resolveMemoryConfig(cfg);
      await withEnv('ANTHROPIC_API_KEY', 'sk-x', async () => {
        const withKey = resolveMemoryConfig(cfg);
        // Identical output regardless of env state — the mapper reads no env.
        expect(withoutKey).toEqual(withKey);
        expect(withKey.consolidation?.provider).toBe('anthropic');
      });
    });
  });

  it('never mutates the input', () => {
    const raw: MemoryUserConfig = {
      consolidation: { enabled: true, provider: 'openai', types: ['bug'] },
    };
    const snapshot = JSON.parse(JSON.stringify(raw)) as MemoryUserConfig;
    resolveMemoryConfig(raw);
    expect(raw).toEqual(snapshot); // input untouched
  });
});

describe('resolveMemoryConfig — structural compatibility with the engine', () => {
  it('the resolved shape is assignable to MemoryConfig (drops into runConsolidation)', () => {
    // Type-level assertion: the resolved shape satisfies the runtime MemoryConfig
    // the engine + runConsolidation consume. If this stops compiling, the bridge
    // can no longer feed the engine without an adapter — a regression.
    const resolved = resolveMemoryConfig({
      consolidation: { enabled: true, provider: 'anthropic', model: 'claude-haiku' },
    });
    // This assignment is the contract: ConsolidationDeps.config: MemoryConfig.
    const asMemoryConfig: MemoryConfig = resolved;
    expect(asMemoryConfig.consolidation?.provider).toBe('anthropic');
    expect(asMemoryConfig.consolidation?.enabled).toBe(true);
  });
});

// Isolate env state so order-independent runs don't bleed NOIR_TEST_* vars or the
// ANTHROPIC_API_KEY probe. resolveMemoryConfig itself reads no env; this is a
// belt-and-braces guard for the withEnv probe above.
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('NOIR_TEST_')) delete process.env[k];
  }
});
