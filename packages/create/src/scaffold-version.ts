import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOIR_DIR } from '@noir-ai/core';
import { regenerate } from './writers.js';

/**
 * Scaffold version stamp — Noir's equivalent of Copier's `last-applied`.
 * Stored at `.noir/scaffold-version` as a single `noir-scaffold=<semver>` line
 * so `noir init --upgrade` / `noir doctor` can diff against
 * {@link CURRENT_SCAFFOLD_VERSION} and decide which migrations to run.
 *
 * Format is line-oriented (not YAML) on purpose: it must be readable before
 * `config.yml` is parsed (doctor runs even with a broken config), and the
 * `key=value` shape is trivial to grep from a shell.
 */

/** The scaffold version this build of @noir-ai/create ships. Bumped atomically
 *  whenever a manifest entry, template, or migration changes shape. */
export const CURRENT_SCAFFOLD_VERSION = '1.0.0';

const PREFIX = 'noir-scaffold=';

/** Path to the stamp file under `root`. Exposed for tests + doctor. */
export function scaffoldVersionPath(root: string): string {
  return join(root, NOIR_DIR, 'scaffold-version');
}

/** Read the applied scaffold version, or `null` if the stamp is absent/unparseable.
 *  Never throws — doctor must keep reporting even on a malformed stamp. */
export function readScaffoldVersion(root: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(scaffoldVersionPath(root), 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PREFIX)) {
      const v = trimmed.slice(PREFIX.length).trim();
      if (v.length > 0) return v;
    }
  }
  return null;
}

/** Write the stamp, creating `.noir/` if needed. The orchestrator writes it
 *  LAST so a crash mid-scaffold leaves an old/absent stamp rather than a
 *  misleading fresh one.
 *
 *  N2: routed through the package's atomic `regenerate()` writer (tmp+rename in
 *  the same dir) for consistency with the rest of the engine's durable writes —
 *  a half-written stamp would mislead `noir doctor`/`init --upgrade`, so the
 *  stamp deserves the same crash-atomicity as `.mcp.json` and the NOIR.md brief. */
export function writeScaffoldVersion(root: string, version: string): void {
  const file = scaffoldVersionPath(root);
  mkdirSync(dirname(file), { recursive: true });
  regenerate(file, `${PREFIX}${version}\n`);
}
