import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../src/providers/openai.js';
import type { CompleteRequest } from '../src/types.js';

// Offline adapter test (blueprint D5 / NFR-1): the `openai` SDK is MOCKED so
// these cases make ZERO network calls. vi.mock intercepts the adapter's DYNAMIC
// `import('openai')` too — Vitest covers static, dynamic, and require forms.
// `vi.hoisted` makes the mock state available to the hoisted factory.
const mocks = vi.hoisted(() => {
  const createMock = vi.fn();
  const ctorOpts: Array<Record<string, unknown>> = [];
  return { createMock, ctorOpts };
});

vi.mock('openai', () => ({
  default: class OpenAI {
    constructor(opts: Record<string, unknown>) {
      mocks.ctorOpts.push(opts);
    }
    chat = { completions: { create: mocks.createMock } };
  },
}));

beforeEach(() => {
  mocks.createMock.mockReset();
  mocks.ctorOpts.length = 0;
});

function baseReq(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return { provider: 'openai', model: 'gpt-4o-mini', prompt: 'say hi', ...overrides };
}

describe('openaiAdapter — request shape (blueprint D5: single-shot, no tools/stream)', () => {
  it('sends ONLY model/messages/max_tokens to chat.completions.create', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'hello' } }] });
    await openaiAdapter.complete(baseReq({ system: 'be brief', maxTokens: 64 }), 'sk-test');

    expect(mocks.createMock).toHaveBeenCalledTimes(1);
    const params = mocks.createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.model).toBe('gpt-4o-mini');
    expect(params.max_tokens).toBe(64);
    // FR-8: the agent-loop surface does not exist on the request.
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('functions');
    expect(params).not.toHaveProperty('stream');
    const messages = params.messages as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('omits max_tokens when maxTokens is unset, and sends only the user turn without a system prompt', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    await openaiAdapter.complete(baseReq(), 'sk-test');
    const params = mocks.createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('max_tokens');
    const messages = params.messages as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('constructs the SDK client with maxRetries: 0 (DS-12: never silently retry)', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    await openaiAdapter.complete(baseReq(), 'sk-test');
    expect(mocks.ctorOpts[0]?.maxRetries).toBe(0);
  });

  it('passes the resolved key value as apiKey (never the env-var name)', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    await openaiAdapter.complete(baseReq(), 'sk-secret-value');
    expect(mocks.ctorOpts[0]?.apiKey).toBe('sk-secret-value');
  });

  it('forwards a configured baseURL to the SDK (custom OpenAI-shaped endpoint)', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    await openaiAdapter.complete(baseReq({ baseURL: 'https://gateway.example/v1' }), 'sk-test');
    expect(mocks.ctorOpts[0]?.baseURL).toBe('https://gateway.example/v1');
  });

  it('forwards req.signal + maxRetries: 0 to the create call options (NFR-3 wall-clock bound)', async () => {
    // The SDK's `create` takes a SECOND options argument for per-request
    // signal / maxRetries. Unlike fetch, the SDK does not inherit the caller's
    // abort — so the adapter must forward `req.signal` explicitly (mirroring
    // how the anthropic adapter forwards signal/maxRetries to messages.create).
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const ac = new AbortController();
    await openaiAdapter.complete(baseReq({ signal: ac.signal }), 'sk-test');
    expect(mocks.createMock).toHaveBeenCalledTimes(1);
    const options = mocks.createMock.mock.calls[0]?.[1] as {
      signal?: AbortSignal;
      maxRetries?: number;
    };
    expect(options.signal).toBe(ac.signal);
    expect(options.maxRetries).toBe(0);
  });
});

describe('openaiAdapter — result mapping', () => {
  it('maps choices[0].message.content + usage → { ok, text, usage }', async () => {
    mocks.createMock.mockResolvedValue({
      choices: [{ message: { content: 'hi there' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    const r = await openaiAdapter.complete(baseReq(), 'sk-test');
    expect(r).toEqual({
      ok: true,
      text: 'hi there',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it('returns { ok: true, text } with NO usage when the SDK omits usage', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: 'no usage' } }] });
    const r = await openaiAdapter.complete(baseReq(), 'sk-test');
    expect(r).toEqual({ ok: true, text: 'no usage' });
    if (r && r.ok === true) expect(r.usage).toBeUndefined();
  });

  it('returns { ok: false } when content is null', async () => {
    mocks.createMock.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const r = await openaiAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('no message content');
  });

  it('returns { ok: false } when choices is empty', async () => {
    mocks.createMock.mockResolvedValue({ choices: [] });
    const r = await openaiAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
  });
});

describe('openaiAdapter — failure handling (never throws)', () => {
  it('turns an SDK rejection into { ok: false, reason }', async () => {
    mocks.createMock.mockRejectedValue(new Error('rate limited'));
    const r = await openaiAdapter.complete(baseReq(), 'sk-test');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.reason).toContain('openai:');
      expect(r.reason).toContain('rate limited');
    }
  });

  it('refuses to run without a key (DS-6: no silent SDK env fallback to OPENAI_API_KEY)', async () => {
    // Hosted OpenAI is always keyed. An anonymous `openai` block must NOT fall
    // through to the SDK's own env read — that would be a silent paid call.
    const r = await openaiAdapter.complete(baseReq(), undefined);
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('API key');
    // The SDK was never even imported for this miss.
    expect(mocks.createMock).not.toHaveBeenCalled();
  });
});
