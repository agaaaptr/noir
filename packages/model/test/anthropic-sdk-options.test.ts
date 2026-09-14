import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';

// The adapter's other tests stub the SDK client factory and assert the options
// it passes. This file checks the OTHER half of that contract against the REAL
// SDK: that the options the adapter pins are enough to keep the ambient
// environment out. Constructing a client is pure (no network), so this stays
// offline. If a future SDK release stops honoring `null` credentials or an
// explicit `baseURL`, these cases fail loudly — which is the signal to re-check
// the adapter's pinning rather than discover it in production.

const AMBIENT = {
  ANTHROPIC_API_KEY: 'sk-ambient-anthropic-key',
  ANTHROPIC_AUTH_TOKEN: 'tk-ambient-bearer',
  ANTHROPIC_BASE_URL: 'https://ambient-gateway.example',
} as const;

// Set every ambient var for one test and restore the previous values after.
function withAmbient(fn: () => void): Promise<void> {
  const before = new Map(Object.keys(AMBIENT).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(AMBIENT)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of before) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

afterEach(() => {
  for (const k of Object.keys(AMBIENT)) delete process.env[k];
});

describe('@anthropic-ai/sdk — the adapter’s pinned options defeat ambient env', () => {
  it('keeps the ambient key out when only a bearer token is configured', async () => {
    await withAmbient(() => {
      const client = new Anthropic({
        apiKey: null,
        authToken: 'tk-configured',
        baseURL: 'https://api.anthropic.com',
        maxRetries: 0,
      });
      // `null` means "no credential" — the SDK does NOT fall back to
      // ANTHROPIC_API_KEY for a null option (only for `undefined`), so no
      // X-Api-Key header carrying the ambient key is ever sent.
      expect(client.apiKey).toBeNull();
      expect(client.authToken).toBe('tk-configured');
    });
  });

  it('keeps the ambient token out when only an API key is configured', async () => {
    await withAmbient(() => {
      const client = new Anthropic({
        apiKey: 'sk-configured',
        authToken: null,
        baseURL: 'https://api.anthropic.com',
        maxRetries: 0,
      });
      expect(client.apiKey).toBe('sk-configured');
      // Not the ambient ANTHROPIC_AUTH_TOKEN, so no stray Authorization header.
      expect(client.authToken).toBeNull();
    });
  });

  it('uses the explicit base URL, never the ambient ANTHROPIC_BASE_URL', async () => {
    await withAmbient(() => {
      const client = new Anthropic({
        apiKey: 'sk-configured',
        authToken: null,
        baseURL: 'https://api.anthropic.com',
        maxRetries: 0,
      });
      expect(client.baseURL).toBe('https://api.anthropic.com');
    });
    await withAmbient(() => {
      const gateway = new Anthropic({
        apiKey: 'sk-configured',
        authToken: null,
        baseURL: 'https://configured-gateway.example',
        maxRetries: 0,
      });
      expect(gateway.baseURL).toBe('https://configured-gateway.example');
    });
  });

  it('warns why the pinning is load-bearing: an OMITTED credential does read the ambient env', async () => {
    // Documents the hazard the adapter's `null` pinning exists to avoid. An
    // `undefined`/omitted option is exactly the case the SDK resolves from
    // process.env, so leaving a credential undefined in the adapter would
    // silently route (and bill) a call the config did not ask for.
    await withAmbient(() => {
      const client = new Anthropic({ baseURL: 'https://api.anthropic.com', maxRetries: 0 });
      expect(client.apiKey).toBe(AMBIENT.ANTHROPIC_API_KEY);
      expect(client.authToken).toBe(AMBIENT.ANTHROPIC_AUTH_TOKEN);
    });
  });
});
