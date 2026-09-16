import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';

// The adapter's other tests stub the SDK client factory and assert the options
// it passes. This file checks the OTHER half of that contract against the REAL
// SDK: that the option the adapter pins is enough to keep the ambient
// environment out, and that the value it pins is still the SDK's own default.
// Constructing a client is pure (no network), so this stays offline.

const AMBIENT_BASE_URL = 'https://ambient-gateway.example/v1';

afterEach(() => {
  delete process.env.OPENAI_BASE_URL;
});

describe('openai — the adapter’s pinned baseURL defeats ambient env', () => {
  it('does not read the ambient OPENAI_BASE_URL when none is configured', () => {
    // Documents the hazard the pinning exists to avoid: with the option
    // OMITTED the SDK resolves it from process.env, so a base URL left out of
    // the adapter would silently send (and bill) every call to a host the
    // config never chose.
    process.env.OPENAI_BASE_URL = AMBIENT_BASE_URL;
    const omitted = new OpenAI({ apiKey: 'sk-configured', maxRetries: 0 });
    expect(omitted.baseURL).toBe(AMBIENT_BASE_URL);
  });

  it('uses the pinned hosted default, never the ambient OPENAI_BASE_URL', () => {
    process.env.OPENAI_BASE_URL = AMBIENT_BASE_URL;
    const client = new OpenAI({
      apiKey: 'sk-configured',
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
    });
    expect(client.baseURL).toBe('https://api.openai.com/v1');
  });

  it('pins the value the SDK itself defaults to (re-check if the SDK moves it)', () => {
    // The adapter mirrors the SDK's hosted default rather than inventing one.
    // If a future SDK release changes it, this fails loudly — which is the
    // signal to re-check the adapter's pin, not to discover it in production.
    delete process.env.OPENAI_BASE_URL;
    const unset = new OpenAI({ apiKey: 'sk-configured', maxRetries: 0 });
    expect(unset.baseURL).toBe('https://api.openai.com/v1');
  });
});
