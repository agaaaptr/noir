// SP-B — Noir banner (TDD). Pure-function tests; no env/TTY mocking.
import { afterEach, describe, expect, it } from 'vitest';
import { NOIR_TAGLINE, renderBanner, shouldShowBanner } from '../src/banner.js';

describe('renderBanner', () => {
  it('wide terminal: renders the multi-line ASCII block wordmark', () => {
    const out = renderBanner({ width: 100, color: false });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(out).toMatch(/█/); // block art present
  });

  it('color:false output has NO ANSI escape codes (snapshot/CI safe)', () => {
    const out = renderBanner({ width: 100, color: false });
    expect(out.includes('\x1b')).toBe(false);
  });

  it('narrow terminal (<50 cols): falls back to a single-line compact mark containing "noir"', () => {
    const out = renderBanner({ width: 40, color: false });
    expect(out).toMatch(/noir/i);
    expect(out.includes('\n')).toBe(false); // single line
  });

  it('exposes the product tagline', () => {
    expect(NOIR_TAGLINE.length).toBeGreaterThan(0);
  });
});

describe('shouldShowBanner', () => {
  const orig = process.env.NOIR_NO_BANNER;
  afterEach(() => {
    if (orig === undefined) delete process.env.NOIR_NO_BANNER;
    else process.env.NOIR_NO_BANNER = orig;
  });

  it('is true by default', () => {
    delete process.env.NOIR_NO_BANNER;
    expect(shouldShowBanner({})).toBe(true);
  });

  it('is false under --quiet', () => {
    expect(shouldShowBanner({ quiet: true })).toBe(false);
  });

  it('is false under --json', () => {
    expect(shouldShowBanner({ json: true })).toBe(false);
  });

  it('is false when NOIR_NO_BANNER is set (non-empty)', () => {
    process.env.NOIR_NO_BANNER = '1';
    expect(shouldShowBanner({})).toBe(false);
  });

  it('is true when NOIR_NO_BANNER is explicitly empty (opt-in semantics)', () => {
    process.env.NOIR_NO_BANNER = '';
    expect(shouldShowBanner({})).toBe(true);
  });
});
