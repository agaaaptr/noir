import { afterEach, describe, expect, it } from 'vitest';
import { clearProviderAdapters, registerProviderAdapter } from '../src/complete.js';
import { draftPrd, PRD_FALLBACK_TEMPLATE } from '../src/draft.js';
import type { CompleteRequest, CompleteResult, ProviderAdapter } from '../src/types.js';

// Mirrors complete.test.ts: a fake adapter records each dispatch and returns a
// canned result, so draftPrd's prompt construction + provider-gating asserts
// with ZERO network. The `withEnv` helper restores env vars between cases.
function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

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

afterEach(() => clearProviderAdapters());

describe('draftPrd — graceful degradation (blueprint D5, first-class null)', () => {
  it('returns null when ModelConfig is empty (no provider configured)', async () => {
    const out = await draftPrd(
      { provider: 'anthropic', model: 'claude-haiku' },
      { intake: 'users cannot log in' },
      {}, // empty config — full degradation
    );
    expect(out).toBeNull();
  });

  it('returns null when the provider is named but NOT configured (env presence is irrelevant)', async () => {
    // ANTHROPIC_API_KEY may be set for another tool; draftPrd must not
    // infer the provider from its presence. The provider block is absent here.
    await withEnv('ANTHROPIC_API_KEY', 'sk-from-another-tool', async () => {
      const out = await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        { intake: 'x' },
        { providers: { openai: { model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' } } },
      );
      expect(out).toBeNull();
    });
  });

  it('returns null for a keyed provider whose env var is missing', async () => {
    await withEnv('NOIR_TEST_PRD_MISSING', undefined, async () => {
      const out = await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        { intake: 'x' },
        { providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_PRD_MISSING' } } },
      );
      expect(out).toBeNull();
    });
  });

  it('NEVER throws — an adapter that rejects degrades to null', async () => {
    registerProviderAdapter(
      'anthropic',
      fakeAdapter('anthropic', () => Promise.reject(new Error('boom'))),
    );
    await withEnv('NOIR_TEST_PRD_OK', 'sk-test', async () => {
      const out = await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        { intake: 'x' },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_PRD_OK' } } },
      );
      expect(out).toBeNull();
    });
  });

  it('returns null on { ok: false } (attempted-call failure collapses to degrade)', async () => {
    registerProviderAdapter(
      'anthropic',
      fakeAdapter('anthropic', () => ({ ok: false, reason: 'upstream 500' })),
    );
    await withEnv('NOIR_TEST_PRD_OK', 'sk-test', async () => {
      const out = await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        { intake: 'x' },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_PRD_OK' } } },
      );
      expect(out).toBeNull();
    });
  });
});

describe('draftPrd — happy path (provider configured + key present)', () => {
  it('returns the model text and threads provider/model through complete()', async () => {
    const fake = fakeAdapter(
      'anthropic',
      (req) =>
        ({
          ok: true,
          text: `## Problem\n${req.prompt.split('\n').slice(0, 2).join(' ')}`,
          usage: { inputTokens: 10, outputTokens: 5 },
        }) satisfies CompleteResult,
    );
    registerProviderAdapter('anthropic', fake);

    await withEnv('NOIR_TEST_PRD_OK', 'sk-test', async () => {
      const out = await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        {
          intake: 'Users cannot log in.',
          clarify: ['Auth flow: SSO vs password? — SSO.'],
          memory: 'related: PRD-101',
        },
        { providers: { anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_PRD_OK' } } },
      );
      expect(out).not.toBeNull();
      expect(out).toContain('## Problem');
      // Provider + model + tier (draft) forwarded to complete().
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.req.provider).toBe('anthropic');
      expect(fake.calls[0]?.req.model).toBe('claude-haiku');
      expect(fake.calls[0]?.req.tier).toBe('draft');
      // Key resolved from the env var named by apiKeyEnv.
      expect(fake.calls[0]?.key).toBe('sk-test');
    });
  });

  it('builds a prompt that carries intake + clarify + memory', async () => {
    const fake = fakeAdapter('anthropic', () => ({ ok: true, text: '## Problem\ndraft' }));
    registerProviderAdapter('anthropic', fake);

    await withEnv('NOIR_TEST_PRD_OK', 'sk-test', async () => {
      await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        {
          intake: 'INTAKE-MARKER',
          clarify: ['CLARIFY-A', 'CLARIFY-B'],
          memory: 'MEMORY-MARKER',
        },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_PRD_OK' } } },
      );
      const prompt = fake.calls[0]?.req.prompt ?? '';
      // All three grounding signals land in the user prompt verbatim.
      expect(prompt).toContain('INTAKE-MARKER');
      expect(prompt).toContain('CLARIFY-A');
      expect(prompt).toContain('CLARIFY-B');
      expect(prompt).toContain('MEMORY-MARKER');
      // The 9 required sections are listed in the output contract.
      for (const section of [
        'Problem',
        'Evidence',
        'Audience',
        'Success Criteria',
        'Appetite / Mode',
        'Proposed Direction',
        'No-gos',
        'Rabbit holes',
        'Open Questions',
      ]) {
        expect(prompt).toContain(section);
      }
    });
  });

  it('omits the Clarification/Memory sections when those inputs are absent', async () => {
    const fake = fakeAdapter('anthropic', () => ({ ok: true, text: 'x' }));
    registerProviderAdapter('anthropic', fake);

    await withEnv('NOIR_TEST_PRD_OK', 'sk-test', async () => {
      await draftPrd(
        { provider: 'anthropic', model: 'claude-haiku' },
        { intake: 'only intake' },
        { providers: { anthropic: { apiKeyEnv: 'NOIR_TEST_PRD_OK' } } },
      );
      const prompt = fake.calls[0]?.req.prompt ?? '';
      expect(prompt).toContain('only intake');
      expect(prompt).not.toContain('Clarification Q&A');
      expect(prompt).not.toContain('Retrieved memory');
    });
  });
});

describe('PRD_FALLBACK_TEMPLATE — the offline substitution', () => {
  it('carries all 9 canonical sections in order (mirrors the noir-prd skill)', () => {
    const sections = [
      '## Problem',
      '## Evidence',
      '## Audience',
      '## Success Criteria',
      '## Appetite / Mode',
      '## Proposed Direction',
      '## No-gos',
      '## Rabbit holes',
      '## Open Questions',
    ];
    for (const s of sections) {
      expect(PRD_FALLBACK_TEMPLATE).toContain(s);
    }
  });

  it('uses <fill in: ...> placeholders (never fabricated content)', async () => {
    // The template MUST be human-completable in place — no fake Evidence, no
    // invented metrics. Every section body is a `<fill in>` placeholder.
    expect(PRD_FALLBACK_TEMPLATE).toMatch(/<fill in:/);
    // And it warns about fabricating Evidence explicitly.
    expect(PRD_FALLBACK_TEMPLATE.toLowerCase()).toContain('never fabricate');
  });
});

// Isolate env state so order-independent runs don't bleed NOIR_TEST_* vars.
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('NOIR_TEST_')) delete process.env[k];
  }
});
