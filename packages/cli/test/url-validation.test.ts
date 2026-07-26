import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-cli-url-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('init --url localhost validation (security hardening)', () => {
  it('accepts http://127.0.0.1:4321/mcp', async () => {
    // init() returns a ScaffoldResult on success (B3 widened the surface so
    // --json callers can read conflicts[]); the URL-validation contract is
    // that the call RESOLVES without throwing.
    await expect(
      init(root, { transport: 'streamable-http', url: 'http://127.0.0.1:4321/mcp' }),
    ).resolves.toBeTruthy();
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  });

  it('accepts http://localhost:4321/mcp', async () => {
    await expect(
      init(root, { transport: 'streamable-http', url: 'http://localhost:4321/mcp' }),
    ).resolves.toBeTruthy();
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  });

  it('rejects non-localhost host (http://evil.com/mcp)', async () => {
    await expect(
      init(root, { transport: 'streamable-http', url: 'http://evil.com/mcp' }),
    ).rejects.toThrow('Only localhost URLs are supported (got evil.com)');
  });

  it('rejects bad protocol (ftp://127.0.0.1/x)', async () => {
    await expect(
      init(root, { transport: 'streamable-http', url: 'ftp://127.0.0.1/x' }),
    ).rejects.toThrow('Only http/https URLs are supported');
  });

  it('rejects malformed input (not a url)', async () => {
    await expect(init(root, { transport: 'streamable-http', url: 'not a url' })).rejects.toThrow(
      'Invalid URL: not a url',
    );
  });

  it('rejects streamable-http without --url', async () => {
    await expect(init(root, { transport: 'streamable-http' })).rejects.toThrow(
      '--transport streamable-http requires --url',
    );
  });
});
