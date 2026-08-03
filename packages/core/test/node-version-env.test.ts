import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANAGED_NODE_VERSION } from '../src/node-provision.js';

/**
 * Drift guard for `scripts/node-version.env`.
 *
 * The shell installers (install.sh / install.ps1) source this file to learn
 * which Node version to provision; @noir-ai/core exposes the same value as the
 * `MANAGED_NODE_VERSION` constant. They MUST agree, or the CLI and the
 * installers would provision different runtimes. This test is offline (reads
 * the repo file, no network) and fails closed on either side drifting.
 */
describe('scripts/node-version.env drift guard', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/core/test/ -> ../../../scripts/node-version.env
  const envPath = join(here, '..', '..', '..', 'scripts', 'node-version.env');
  const text = readFileSync(envPath, 'utf8');

  /** Parse `KEY=VALUE` lines, skipping blanks and `#` comments. */
  const vars: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }

  it('defines MANAGED_NODE_VERSION as a valid X.Y.Z semver', () => {
    expect(vars.MANAGED_NODE_VERSION, 'MANAGED_NODE_VERSION must be set').toBeDefined();
    expect(vars.MANAGED_NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('MANAGED_NODE_VERSION matches @noir-ai/core constant (no drift)', () => {
    expect(vars.MANAGED_NODE_VERSION).toBe(MANAGED_NODE_VERSION);
  });

  it('defines NODE_DIST_BASE_URL as the nodejs.org dist root', () => {
    expect(vars.NODE_DIST_BASE_URL, 'NODE_DIST_BASE_URL must be set').toBeDefined();
    expect(vars.NODE_DIST_BASE_URL).toBe('https://nodejs.org/dist');
  });

  it('pins Node 22 LTS (the engines >= 22 floor, Jod active LTS)', () => {
    const major = Number((vars.MANAGED_NODE_VERSION ?? '0.0.0').split('.')[0]);
    expect(major).toBe(22);
  });

  it('contains no `export` keyword (powershell must be able to parse it)', () => {
    // node-version.env is intentionally plain KEY=VALUE so PowerShell's
    // Load-NodeEnv can parse it line-by-line; bash sources it via `set -a`.
    expect(text).not.toMatch(/^\s*export\s+/m);
  });
});
