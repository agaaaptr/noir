// Project-local environment file loader (`.noir/.env`), so tokens (e.g.
// CLICKUP_API_TOKEN) are available even when the CLI/daemon is launched from a
// context that does not inherit the user's shell rc (GUI MCP clients, launchd).
//
// Semantics (the 12-factor / dotenv / Node --env-file consensus):
//   - the REAL environment always wins; `.noir/.env` fills only UNSET keys;
//   - a missing file is a silent no-op (Node --env-file-if-exists behavior);
//   - the parser is the documented Node --env-file dialect (the conformance
//     oracle for this hand-rolled ~40-LOC subset — no new dependency);
//   - NO `${VAR}` interpolation and NO command substitution, by design (a
//     dotenv file is data, not a script);
//   - malformed lines are skipped with a one-line stderr warning + line number,
//     never a crash.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NOIR_DIR } from './layout.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvFileParseResult {
  readonly vars: Record<string, string>;
  /** `file:line: reason` diagnostics for skipped lines. */
  readonly warnings: string[];
}

/**
 * Parse dotenv-dialect text. Rules (Node --env-file): `KEY=VALUE` per line;
 * blank lines and full-line `#` comments skipped; an optional `export ` prefix
 * is ignored; split on the FIRST `=`; keys must match `[A-Za-z_][A-Za-z0-9_]*`;
 * unquoted values are trimmed and a trailing `#` starts a comment; single- and
 * double-quoted values keep their inner whitespace and `#`; `EMPTY=` → `''`;
 * the last definition of a key wins.
 */
export function parseEnvFile(text: string): EnvFileParseResult {
  const vars: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]?.trim() ?? '';
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const eq = line.indexOf('=');
    if (eq === -1) {
      warnings.push(`.noir/.env:${i + 1}: no '=' — skipped`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      warnings.push(`.noir/.env:${i + 1}: invalid key '${key}' — skipped`);
      continue;
    }
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    vars[key] = value; // last definition wins
  }
  return { vars, warnings };
}

export interface LoadedEnv {
  /** Key→value overlay to apply (only keys UNSET in the real environment). */
  readonly overlay: Record<string, string>;
  readonly warnings: string[];
}

/**
 * Read `<root>/.noir/.env` (missing = no-op) and compute the overlay to apply:
 * every parsed var whose key is NOT already set in `env` (real env wins; the
 * file never overrides).
 */
export function loadNoirEnv(
  root: string,
  env: Record<string, string | undefined> = process.env,
): LoadedEnv {
  const path = join(root, NOIR_DIR, '.env');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { overlay: {}, warnings: [] }; // missing file — silent no-op
  }
  const { vars, warnings } = parseEnvFile(text);
  // Permission advisory (names-only, never values): a group/world-readable .env
  // leaks tokens to other local users — the ssh/aws-credentials convention.
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      warnings.push(
        `.noir/.env: permissions ${(st.mode & 0o777).toString(8)} allow others to read — run chmod 600`,
      );
    }
  } catch {
    /* stat race (deleted between read + stat) — no advisory */
  }
  const overlay: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (env[k] === undefined) overlay[k] = v;
  }
  return { overlay, warnings };
}

/**
 * Load + apply `.noir/.env` to `env` (default `process.env`) in place, warning
 * on malformed lines. Returns the applied overlay. Idempotent — call once at
 * process start (CLI entry + daemon/serve entry).
 */
export function applyNoirEnv(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const { overlay, warnings } = loadNoirEnv(root, env);
  for (const [k, v] of Object.entries(overlay)) {
    (env as Record<string, string>)[k] = v;
  }
  for (const w of warnings) process.stderr.write(`${w}\n`);
  return overlay;
}
