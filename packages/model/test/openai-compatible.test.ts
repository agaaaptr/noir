import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openaiCompatibleAdapter } from '../src/providers/openai-compatible.js';
import type { CompleteRequest } from '../src/types.js';

// Offline adapter test (blueprint D5 / NFR-1): GLOBAL `fetch` is replaced with a
// spy, so these cases make ZERO network calls — they assert the OpenAI-shaped
// request the adapter builds and its response mapping. Save/restore the real
// fetch so other suites are unaffected.
const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function baseReq(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    provider: 'openai-compatible',
    model: 'llama3.1',
    prompt: 'say hi',
    baseURL: 'http://localhost:11434/v1',
    ...overrides,
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('openaiCompatibleAdapter — request shape (blueprint D5)', () => {
  it('POSTs to ${baseURL}/chat/completions with model/messages/max_tokens + Bearer key', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }));
    await openaiCompatibleAdapter.complete(baseReq({ system: 'be brief', maxTokens: 128 }), 'sk-x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('llama3.1');
    expect(body.max_tokens).toBe(128);
    // FR-8: no agent-loop surface on the wire either.
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('functions');
    expect(body).not.toHaveProperty('stream');
    const messages = body.messages as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer sk-x');
  });

  it('strips a trailing slash from baseURL before joining /chat/completions', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }));
    await openaiCompatibleAdapter.complete(baseReq({ baseURL: 'http://localhost:11434/v1/' }));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('sends NO Authorization header for an anonymous local provider (Ollama)', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }));
    // key undefined ⇒ anonymous; the local server needs no auth.
    await openaiCompatibleAdapter.complete(baseReq(), undefined);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('omits max_tokens when maxTokens is unset', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }));
    await openaiCompatibleAdapter.complete(baseReq(), 'sk-x');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('max_tokens');
  });
});

describe('openaiCompatibleAdapter — result mapping + failure handling', () => {
  it('maps choices[0].message.content + usage → { ok, text, usage }', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'hello world' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    );
    const r = await openaiCompatibleAdapter.complete(baseReq(), 'sk-x');
    expect(r).toEqual({
      ok: true,
      text: 'hello world',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });

  it('forwards the request signal to fetch (caller wall-clock bound)', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }));
    const ac = new AbortController();
    await openaiCompatibleAdapter.complete(baseReq({ signal: ac.signal }), 'sk-x');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(ac.signal);
  });

  it('returns { ok: false } on a non-2xx HTTP status — without leaking the raw body (NFR-4)', async () => {
    // A malicious / echoing endpoint (Ollama, LM Studio, vLLM, any gateway)
    // could echo the request body (the prompt) or reflect headers (the Bearer
    // / `sk-` key) into its error frame. `reason` must surface ONLY the HTTP
    // status — never the raw response body text.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom internal',
    } as Response);
    const r = await openaiCompatibleAdapter.complete(baseReq(), 'sk-x');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.reason).toMatch(/HTTP 5\d\d/);
      // The raw body (which an echoing server could fill with prompt/key
      // material) must NOT be surfaced.
      expect(r.reason).not.toContain('boom');
      expect(r.reason).not.toContain('internal');
    }
  });

  it('returns { ok: false } when content is missing', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: null } }] }));
    const r = await openaiCompatibleAdapter.complete(baseReq(), 'sk-x');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('no message content');
  });

  it('returns { ok: false } when baseURL is absent (misconfiguration) — without calling fetch', async () => {
    const r = await openaiCompatibleAdapter.complete(baseReq({ baseURL: undefined }), 'sk-x');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('baseURL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a network failure into { ok: false } (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await openaiCompatibleAdapter.complete(baseReq(), 'sk-x');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('ECONNREFUSED');
  });

  it('reports an aborted request distinctly', async () => {
    const err = new Error('the user aborted');
    err.name = 'AbortError';
    fetchMock.mockRejectedValue(err);
    const r = await openaiCompatibleAdapter.complete(baseReq(), 'sk-x');
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('aborted');
  });
});
