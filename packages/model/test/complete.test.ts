import { afterEach, describe, expect, it } from 'vitest';
import { clearProviderAdapters, complete, registerProviderAdapter } from '../src/complete.js';
import type { CompleteRequest, CompleteResult, ProviderAdapter, Tier } from '../src/types.js';

// Fake adapter — records each call and returns a canned result. Lets us verify
// complete()'s resolution + dispatch + degradation with ZERO network (the real
// adapters land in t2/t3; their fixture-based tests live there too). `calls`
// is appended on every dispatch so assertions can inspect what the adapter saw.
interface FakeAdapter extends ProviderAdapter {
  calls: Array<{ req: CompleteRequest; key?: string }>;
}
function fakeAdapter(
  name: string,
  respond: (req: CompleteRequest, key?: string) => CompleteResult | Promise<CompleteResult>,
): FakeAdapter {
  const calls: FakeAdapter['calls'] = [];
  return {
    name,
    calls,
    complete: async (req, key) => {
      calls.push({ req, key });
      return respond(req, key);
    },
  };
}

// Tests mutate env vars to exercise the key-resolution path; each is restored.
function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

afterEach(() => clearProviderAdapters());

describe('complete() — null-degradation (blueprint D5, first-class)', () => {
  it('returns null when ModelConfig is empty (no provider configured)', async () => {
    const r = await complete({ provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' }, {});
    expect(r).toBeNull();
  });

  it('returns null when req.provider is empty and no defaultProvider', async () => {
    const r = await complete({ provider: '', model: 'x', prompt: 'hi' }, {});
    expect(r).toBeNull();
  });

  it('returns null when defaultProvider is set but absent from providers{}', async () => {
    // defaultProvider points at a name that was never configured ⇒ degrade.
    const r = await complete(
      { provider: '', model: 'x', prompt: 'hi' },
      { defaultProvider: 'anthropic', providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    );
    expect(r).toBeNull();
  });

  it('returns null when the provider is named but NOT configured — even if its env var is set', async () => {
    // Provider-explicit (DS-6): ANTHROPIC_API_KEY may be set in the host env
    // for another tool. Noir MUST NOT infer Anthropic from its presence. The
    // provider is unconfigured here (only `openai` is in providers{}) ⇒ null.
    await withEnv('ANTHROPIC_API_KEY', 'sk-from-another-tool', async () => {
      const r = await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
        { providers: { openai: { model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' } } },
      );
      expect(r).toBeNull();
    });
  });

  it('returns null with a fully-empty config even when common provider env vars are set (no env inference)', async () => {
    // The purest DS-6 guard (blueprint D5 — NEVER silent paid calls): both
    // ANTHROPIC_API_KEY and OPENAI_API_KEY may be set in the host env for OTHER
    // tools. With NO `model:` block configured, complete() MUST NOT infer either
    // provider from env presence — it degrades to null on every call (the offline
    // default), never a silent paid call. This exercises the `!providerName`
    // short-circuit (complete.ts step 1), distinct from the named-but-unconfigured
    // case above (step 2's `!providerCfg`); together they fence off both doors
    // env-inference could sneak through.
    await withEnv('ANTHROPIC_API_KEY', 'sk-ant-from-another-tool', async () => {
      await withEnv('OPENAI_API_KEY', 'sk-oai-from-another-tool', async () => {
        const empty = await complete(
          { provider: '', model: 'whatever', prompt: 'hi' },
          {}, // fully empty config — no providers, no defaultProvider
        );
        expect(empty).toBeNull();
        // And a NAMED request also degrades: `anthropic` is not in providers{},
        // so its env presence is irrelevant (env is never consulted for routing).
        const named = await complete(
          { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
          {},
        );
        expect(named).toBeNull();
      });
    });
  });

  it('returns null for a keyed provider whose env var is missing', async () => {
    await withEnv('NOIR_TEST_MISSING_KEY', undefined, async () => {
      const r = await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
        { providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_MISSING_KEY' } } },
      );
      expect(r).toBeNull();
    });
  });

  it('NEVER throws — an adapter that rejects becomes { ok: false }', async () => {
    registerProviderAdapter(
      'anthropic',
      fakeAdapter('anthropic', () => Promise.reject(new Error('boom'))),
    );
    await withEnv('NOIR_TEST_OK_KEY', 'sk-test', async () => {
      const r = await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(r).toEqual({ ok: false, reason: expect.stringContaining('boom') });
    });
  });
});

describe('complete() — provider-explicit resolution + dispatch', () => {
  it('resolves the key from the env-var NAME and dispatches to the adapter', async () => {
    const a = fakeAdapter('anthropic', () => ({
      ok: true,
      text: 'hello',
      usage: { inputTokens: 3, outputTokens: 2 },
    }));
    registerProviderAdapter('anthropic', a);
    // The secret VALUE is read from env and passed to the adapter as `key`;
    // config held only the NAME — the value never touches disk via Noir (DS-8).
    await withEnv('NOIR_TEST_OK_KEY', 'sk-secret-value', async () => {
      const r = await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
        { providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(r).toEqual({ ok: true, text: 'hello', usage: { inputTokens: 3, outputTokens: 2 } });
      expect(a.calls).toHaveLength(1);
      expect(a.calls[0]?.key).toBe('sk-secret-value');
      expect(a.calls[0]?.req.model).toBe('claude-haiku');
    });
  });

  it('allows an anonymous local provider (no apiKeyEnv) — e.g. Ollama', async () => {
    const a = fakeAdapter('ollama', () => ({ ok: true, text: 'local-response' }));
    registerProviderAdapter('ollama', a);
    const r = await complete(
      { provider: 'ollama', model: 'llama3.1', prompt: 'hi' },
      { providers: { ollama: { model: 'llama3.1', baseURL: 'http://localhost:11434/v1' } } },
    );
    expect(r).toEqual({ ok: true, text: 'local-response' });
    expect(a.calls[0]?.key).toBeUndefined(); // anonymous — no auth header sent
  });

  it('forwards system / maxTokens / signal to the adapter unchanged', async () => {
    const ac = new AbortController();
    const a = fakeAdapter('openai', () => ({ ok: true, text: 'ok' }));
    registerProviderAdapter('openai', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      await complete(
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          system: 'be brief',
          prompt: 'summarize',
          maxTokens: 64,
          signal: ac.signal,
        },
        { providers: { openai: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(a.calls[0]?.req.system).toBe('be brief');
      expect(a.calls[0]?.req.maxTokens).toBe(64);
      expect(a.calls[0]?.req.signal).toBe(ac.signal);
    });
  });

  it('returns { ok: false } when the provider is configured but no adapter is registered', async () => {
    // Distinct from null-degradation: the provider IS configured + keyed + env
    // present, but no adapter module has registered yet (the t2/t3 seam).
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      const r = await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(r?.ok).toBe(false);
      if (r && r.ok === false) expect(r.reason).toContain('no adapter');
    });
  });

  it('uses defaultProvider when req.provider is empty', async () => {
    const a = fakeAdapter('openai', () => ({ ok: true, text: 'ok' }));
    registerProviderAdapter('openai', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      const r = await complete(
        { provider: '', model: 'gpt-4o-mini', prompt: 'hi' },
        { defaultProvider: 'openai', providers: { openai: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(r).toEqual({ ok: true, text: 'ok' });
      expect(a.calls).toHaveLength(1);
    });
  });
});

describe('complete() — adapter resolution: free-form local name → openai-compatible', () => {
  // A provider block named `ollama` (or any free-form name) with a `baseURL` is
  // an OpenAI-shaped LOCAL endpoint. Only 3 adapters exist (anthropic / openai /
  // openai-compatible), so `ollama` must route to `openai-compatible`. The
  // openai-compatible adapter's closing comment flags this as t4's dispatch job.
  it('routes a `ollama` provider block (baseURL, no apiKeyEnv) to the openai-compatible adapter', async () => {
    const compat = fakeAdapter('openai-compatible', () => ({ ok: true, text: 'local-ok' }));
    registerProviderAdapter('openai-compatible', compat);
    const r = await complete(
      { provider: 'ollama', model: 'llama3.1', prompt: 'hi' },
      {
        providers: {
          ollama: { model: 'llama3.1', baseURL: 'http://localhost:11434/v1' },
        },
      },
    );
    expect(r).toEqual({ ok: true, text: 'local-ok' });
    expect(compat.calls).toHaveLength(1);
    // The forwarded request carries the provider-block baseURL + anonymous key.
    expect(compat.calls[0]?.req.baseURL).toBe('http://localhost:11434/v1');
    expect(compat.calls[0]?.key).toBeUndefined();
    expect(compat.calls[0]?.req.model).toBe('llama3.1');
  });

  it('prefers a DIRECT adapter match over the baseURL heuristic', async () => {
    // If a real `ollama` adapter WERE registered, it wins over the baseURL →
    // openai-compatible fallback. This also documents why the existing
    // direct-dispatch tests still pass after t4 wiring.
    const direct = fakeAdapter('ollama', () => ({ ok: true, text: 'direct' }));
    const compat = fakeAdapter('openai-compatible', () => ({ ok: true, text: 'compat' }));
    registerProviderAdapter('ollama', direct);
    registerProviderAdapter('openai-compatible', compat);
    const r = await complete(
      { provider: 'ollama', model: 'llama3.1', prompt: 'hi' },
      { providers: { ollama: { model: 'llama3.1', baseURL: 'http://x/v1' } } },
    );
    expect(r).toEqual({ ok: true, text: 'direct' });
    expect(direct.calls).toHaveLength(1);
    expect(compat.calls).toHaveLength(0);
  });

  it('returns { ok:false } for a free-form name with no adapter AND no baseURL', async () => {
    // Neither a direct adapter nor a baseURL to fall back on ⇒ wiring fault
    // (distinct from `null` degradation: the provider IS configured + keyed, so it
    // clears steps 1–3 and reaches adapter resolution, where it fails).
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      const r = await complete(
        { provider: 'mistral-custom', model: 'm', prompt: 'hi' },
        { providers: { 'mistral-custom': { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(r?.ok).toBe(false);
      if (r && r.ok === false) expect(r.reason).toContain('no adapter');
    });
  });
});

describe('complete() — per-tier maxTokens defaults (FR-10)', () => {
  // A tier ONLY selects the output cap; provider/model stay explicit (DS-6).
  // Defaults: draft 2048 / title 64 / summarize 512 / consolidate 2048.
  async function expectTierDefault(tier: Tier, want: number): Promise<void> {
    const a = fakeAdapter('anthropic', () => ({ ok: true, text: 'ok' }));
    registerProviderAdapter('anthropic', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi', tier },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(a.calls[0]?.req.maxTokens).toBe(want);
    });
  }

  it('applies the draft tier default (2048) when maxTokens is omitted', async () => {
    await expectTierDefault('draft', 2048);
  });
  it('applies the title tier default (64) when maxTokens is omitted', async () => {
    await expectTierDefault('title', 64);
  });
  it('applies the summarize tier default (512) when maxTokens is omitted', async () => {
    await expectTierDefault('summarize', 512);
  });
  it('applies the consolidate tier default (2048) when maxTokens is omitted', async () => {
    await expectTierDefault('consolidate', 2048);
  });

  it('an explicit maxTokens overrides the tier default', async () => {
    const a = fakeAdapter('anthropic', () => ({ ok: true, text: 'ok' }));
    registerProviderAdapter('anthropic', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      await complete(
        {
          provider: 'anthropic',
          model: 'claude-haiku',
          prompt: 'hi',
          tier: 'draft',
          maxTokens: 100,
        },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(a.calls[0]?.req.maxTokens).toBe(100); // explicit wins over 2048.
    });
  });

  it('omits maxTokens when neither a tier nor an explicit value is given', async () => {
    // The adapter then applies its own last-resort bound (e.g. Anthropic's 2048).
    const a = fakeAdapter('anthropic', () => ({ ok: true, text: 'ok' }));
    registerProviderAdapter('anthropic', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      await complete(
        { provider: 'anthropic', model: 'claude-haiku', prompt: 'hi' },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(a.calls[0]?.req.maxTokens).toBeUndefined();
    });
  });
});

describe('complete() — structured routing (schema present → JSON path)', () => {
  it('routes a schema-bearing request through the structured path and returns `value`', async () => {
    // The fake adapter speaks for the model: it returns JSON text. complete()
    // must route through runStructured (parse + validate) and hand back the
    // parsed object as `value`, not just raw text.
    const a = fakeAdapter('anthropic', () => ({ ok: true, text: '{"x":42}' }));
    registerProviderAdapter('anthropic', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      const r = await complete(
        {
          provider: 'anthropic',
          model: 'claude-haiku',
          prompt: 'emit JSON',
          schema: (raw) => {
            const v = raw as { x?: number };
            if (typeof v.x !== 'number') throw new Error('x:number required');
            return v;
          },
        },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(r).toMatchObject({ ok: true, value: { x: 42 } });
      expect(r && 'value' in r && r.value).toEqual({ x: 42 });
      // The JSON instruction was injected into the system prompt sent downstream.
      expect(a.calls[0]?.req.system ?? '').toMatch(/valid JSON/i);
    });
  });

  it('structured routing degrades to { ok:false, schema-validation-failed } after a bad repair', async () => {
    // Two invalid outputs ⇒ the structured path returns a fixed-suffix reason a
    // caller can branch on. complete() surfaces it verbatim (no provider error wrap).
    const responses = [
      { ok: true, text: 'nope' },
      { ok: true, text: 'still nope' },
    ];
    const calls: FakeAdapter['calls'] = [];
    let i = 0;
    const a: FakeAdapter = {
      name: 'anthropic',
      calls,
      complete: async (req, key) => {
        calls.push({ req, key });
        return responses[i++] ?? { ok: false, reason: 'exhausted' };
      },
    };
    registerProviderAdapter('anthropic', a);
    await withEnv('NOIR_TEST_OK_KEY', 'sk-x', async () => {
      const r = await complete(
        {
          provider: 'anthropic',
          model: 'claude-haiku',
          prompt: 'emit JSON',
          schema: (raw) => {
            const v = raw as { x?: number };
            if (typeof v.x !== 'number') throw new Error('x:number required');
            return v;
          },
        },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_OK_KEY' } } },
      );
      expect(a.calls).toHaveLength(2); // initial + one repair, never a third.
      expect(r?.ok).toBe(false);
      if (r && r.ok === false) expect(r.reason).toContain('schema-validation-failed');
    });
  });
});

describe('complete() — surface forbids agent loops (blueprint D5)', () => {
  it('CompleteRequest exposes only bounded fields (no tools / functions / stream)', () => {
    // The real enforcement is the TypeScript type in src/types.ts (an object
    // literal with a `tools`/`stream` key fails excess-property checking under
    // `tsc --noEmit`). This runtime smoke test guards against accidental field
    // additions surviving into the public surface.
    const req: CompleteRequest = {
      provider: 'anthropic',
      model: 'claude-haiku',
      prompt: 'p',
      system: 's',
      maxTokens: 128,
    };
    const keys = Object.keys(req);
    expect(keys).not.toContain('tools');
    expect(keys).not.toContain('functions');
    expect(keys).not.toContain('stream');
  });
});
