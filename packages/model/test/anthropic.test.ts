import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from '../src/providers/anthropic.js';
import type { CompleteRequest } from '../src/types.js';

// Offline adapter test (blueprint D5 / NFR-1): the `@anthropic-ai/sdk` is MOCKED
// so these cases make ZERO network calls. vi.mock intercepts the adapter's
// DYNAMIC `import('@anthropic-ai/sdk')` too — Vitest covers static, dynamic, and
// require forms. `vi.hoisted` makes the mock state available to the hoisted
// factory. The `create` mock is a vi.fn so both the params AND the per-request
// options arg (signal / maxRetries) are inspectable on `mock.calls`.
const mocks = vi.hoisted(() => {
  const createMock = vi.fn();
  const ctorOpts: Array<Record<string, unknown>> = [];
  return { createMock, ctorOpts };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor(opts: Record<string, unknown>) {
      mocks.ctorOpts.push(opts);
    }
    messages = { create: mocks.createMock };
  },
}));

beforeEach(() => {
  mocks.createMock.mockReset();
  mocks.ctorOpts.length = 0;
});

function baseReq(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return { provider: 'anthropic', model: 'claude-haiku', prompt: 'say hi', ...overrides };
}

// The recorded Anthropic Messages response shape the adapter consumes: a single
// text content block + usage counts. Per-test cases override the resolved value.
function message(text: string, usage = { input_tokens: 7, output_tokens: 3 }) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage,
  };
}

describe('anthropicAdapter — request shape (blueprint D5: single-shot, no tools/stream)', () => {
  it('sends ONLY model/max_tokens/messages (+system) to messages.create', async () => {
    mocks.createMock.mockResolvedValue(message('hello'));
    await anthropicAdapter.complete(baseReq({ system: 'be brief', maxTokens: 64 }), 'sk-test');

    expect(mocks.createMock).toHaveBeenCalledTimes(1);
    const params = mocks.createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.model).toBe('claude-haiku');
    expect(params.max_tokens).toBe(64);
    expect(params.system).toBe('be brief');
    // `system` is a TOP-LEVEL Anthropic param — it must NOT be folded into the
    // messages array (contrast OpenAI, where system is a message role).
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('say hi');
    // FR-8: the agent-loop surface does not exist on the request.
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('tool_choice');
    expect(params).not.toHaveProperty('functions');
    expect(params).not.toHaveProperty('stream');
  });

  it('omits system when unset (no empty system turn), keeps the single user turn', async () => {
    mocks.createMock.mockResolvedValue(message('ok'));
    await anthropicAdapter.complete(baseReq(), 'sk-test');
    const params = mocks.createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('system');
    const messages = params.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('applies the default max_tokens (2048) when maxTokens is unset — the Messages API requires it', async () => {
    // Unlike OpenAI (where max_tokens is optional), Anthropic REQUIRES it; the
    // adapter fills a last-resort default so the call is always well-formed.
    mocks.createMock.mockResolvedValue(message('ok'));
    await anthropicAdapter.complete(baseReq(), 'sk-test');
    const params = mocks.createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.max_tokens).toBe(2048);
  });

  it('constructs the SDK client with apiKey=value + maxRetries: 0', async () => {
    mocks.createMock.mockResolvedValue(message('ok'));
    await anthropicAdapter.complete(baseReq(), 'sk-secret-value');
    // The env VALUE is passed (resolved by complete()), never the env-var NAME.
    expect(mocks.ctorOpts[0]?.apiKey).toBe('sk-secret-value');
    // Never silently retry (bounded cost).
    expect(mocks.ctorOpts[0]?.maxRetries).toBe(0);
  });

  it('passes maxRetries: 0 + an AbortSignal in the per-request options', async () => {
    mocks.createMock.mockResolvedValue(message('ok'));
    const ac = new AbortController();
    await anthropicAdapter.complete(baseReq({ signal: ac.signal }), 'sk-test');
    const options = mocks.createMock.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(options?.maxRetries).toBe(0); // belt-and-suspenders alongside the constructor.
    expect(options?.signal).toBe(ac.signal);
  });

  it('still sends maxRetries: 0 in options when no signal is given', async () => {
    mocks.createMock.mockResolvedValue(message('ok'));
    await anthropicAdapter.complete(baseReq(), 'sk-test');
    const options = mocks.createMock.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(options?.maxRetries).toBe(0);
    expect(options).not.toHaveProperty('signal');
  });

  it('ignores a forwarded baseURL (hosted Anthropic has no baseURL knob)', async () => {
    // complete() forwards baseURL onto the request for the openai-compatible
    // adapter; the anthropic adapter must not be confused by its presence.
    mocks.createMock.mockResolvedValue(message('ok'));
    await anthropicAdapter.complete(baseReq({ baseURL: 'http://localhost:11434/v1' }), 'sk-test');
    expect(mocks.ctorOpts[0]).not.toHaveProperty('baseURL');
    const params = mocks.createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('baseURL');
  });
});

describe('anthropicAdapter — result mapping', () => {
  it('maps content[0].text + usage → { ok, text, usage } (snake → camel)', async () => {
    mocks.createMock.mockResolvedValue(message('hi there', { input_tokens: 11, output_tokens: 7 }));
    const r = await anthropicAdapter.complete(baseReq(), 'sk-test');
    expect(r).toEqual({
      ok: true,
      text: 'hi there',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it('returns { ok: false } when content is empty (no text block)', async () => {
    mocks.createMock.mockResolvedValue({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const r = await anthropicAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('no text block');
  });

  it('returns { ok: false } when the first block is not a text block', async () => {
    // We never send `tools`, so a non-text block should not occur in practice —
    // but the adapter must not hand back undefined as text if it ever does.
    mocks.createMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const r = await anthropicAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('no text block');
  });
});

describe('anthropicAdapter — failure handling (never throws, never silent paid)', () => {
  it('turns an SDK rejection into { ok: false, reason } (complete() backstop aside)', async () => {
    mocks.createMock.mockRejectedValue(new Error('rate limited'));
    const r = await anthropicAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.reason).toContain('anthropic:');
      expect(r.reason).toContain('rate limited');
    }
  });

  it('turns a non-Error throw into { ok: false, reason } (stringified)', async () => {
    mocks.createMock.mockRejectedValue('boom-string');
    const r = await anthropicAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('boom-string');
  });

  it('returns { ok: false } when key is absent — does NOT let the SDK fall back to ANTHROPIC_API_KEY', async () => {
    // A missing key here means the provider block was wired without apiKeyEnv.
    // The adapter MUST refuse rather than read env silently (silent paid call).
    // No create call should be made at all.
    const r = await anthropicAdapter.complete(baseReq(), undefined);
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('missing API key');
    expect(mocks.createMock).not.toHaveBeenCalled();
    expect(mocks.ctorOpts).toHaveLength(0); // never constructed the SDK client.
  });

  it('registers under the provider name "anthropic"', () => {
    expect(anthropicAdapter.name).toBe('anthropic');
  });
});
