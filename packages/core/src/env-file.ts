// Project-local environment file loader (`.noir/.env`), so tokens (e.g.
// CLICKUP_API_TOKEN) are available even when the CLI/daemon is launched from a
// context that does not inherit the user's shell rc (GUI MCP clients, launchd).
//
// Semantics (spec 12.1). NOTE the deliberate departure from the 12-factor /
// dotenv / Node --env-file consensus, which fills only UNSET keys:
//   - a key `.noir/.env` DEFINES wins; the REAL environment is the FALLBACK for
//     the keys the file omits. For PROJECT configuration the project file must
//     be able to describe the project — under fill-only-unset a token exported
//     from `~/.zshrc` silently shadows the one the user just put in the project
//     file, which is the bug this precedence exists to kill;
//   - `sources` records which side won, per key, so `noir env` + doctor can
//     report provenance without re-reading anything (names only, never values);
//   - a missing file is a silent no-op (Node --env-file-if-exists behavior);
//   - a file git TRACKS is refused outright (spec 12.2): it may have arrived
//     with the clone, and under this precedence it could redirect a credential
//     that the fallback supplies. Untracked (the normal case — Noir's managed
//     .gitignore block lists `/.noir/.env`) is trusted;
//   - the parser is the documented Node --env-file dialect (the conformance
//     oracle for this hand-rolled ~40-LOC subset — no new dependency);
//   - NO `${VAR}` interpolation and NO command substitution, by design (a
//     dotenv file is data, not a script);
//   - malformed lines are skipped with a one-line stderr warning + line number,
//     never a crash.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isGitTracked } from './git-tracked.js';
import { NOIR_DIR } from './layout.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Repo-relative path of the env file, spelled as a POSIX literal.
 *
 * This must NEVER be a `path.join(NOIR_DIR, '.env')` product. Git pathspecs are
 * canonically forward-slash separated on every platform, and on Windows `join`
 * yields `.noir\.env` — which `ls-files --error-unmatch` can match nothing
 * against, reporting a TRACKED file as untracked and silently disabling the
 * git-tracked refusal on Windows only. Same convention as `IGNORE_ENTRIES` in
 * ignore-manager.ts (which also spells `/.noir/.env` literally). Keep in sync
 * with `NOIR_DIR`.
 */
const ENV_FILE_REL_PATH = '.noir/.env';

/**
 * Keys a `.noir/.env` may NEVER set — process-injection vectors. Noir spawns
 * node child processes (the daemon, the host binary), so a `.noir/.env` from an
 * untrusted checkout (e.g. an attacker-committed file in a cloned repo) setting
 * `NODE_OPTIONS=--require=/tmp/evil.js` (or `LD_PRELOAD`, npm_config_*, …) would
 * be inherited by a spawned node child → arbitrary code execution as the user.
 * These keys are refused + warned, preserving the "the file wins for normal
 * token vars" precedence rule for ordinary configuration.
 */
// The `npm`/`COREPACK` alternatives use a `(?:$|_)` boundary, NOT a bare `$`:
// an anchored alternation's `npm_` would match ONLY the literal string `npm_`
// (never `npm_config_registry`), silently defeating the deny-list for real
// descendant keys. The boundary admits both the exact names and every
// `npm_*` / `COREPACK_*` descendant.
//
// That same boundary is why each NOIR_* name must be its own alternative: it
// admits descendants (`NOIR_RUNTIME_DIR_X`) but never sibling names, so
// `NOIR_DAEMON_JSON` does NOT cover `NOIR_DAEMON_DIR` (spec 4.4 — the daemon
// record directory is read through, so redirecting it is a hijack vector).
const PROCESS_INJECTION_ENV_RE =
  /^(NODE_OPTIONS|NODE_PATH|NODE_ICU_DATA|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|ELECTRON_RUN_AS_NODE|NOIR_NODE_DIST_URL|NOIR_UPDATE_CACHE_JSON|NOIR_RUNTIME_DIR|NOIR_DAEMON_JSON|NOIR_DAEMON_DIR|NOIR_INSTALL_JSON|NOIR_MCP_COMMAND|NOIR_SYSTEM_NODE_BIN|NOIR_WORKSPACES_DIR|npm|COREPACK)(?:$|_)/;

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
    const first = value[0];
    if (first === '"' || first === "'") {
      // Quoted value: find the MATCHING closing quote (honoring backslash
      // escapes and the doubled-quote idiom `''`/`""` for a literal quote), so
      // an interior quote is NOT silently truncated (the previous first-
      // occurrence scan sliced `FOO='it''s'` to `it`). A trailing `# …` after
      // the closing quote is dropped; a `#` inside the quotes is preserved.
      let close = -1;
      for (let j = 1; j < value.length; j++) {
        const c = value[j];
        if (c === '\\' && j + 1 < value.length) {
          j++; // skip the escaped char
          continue;
        }
        if (c === first) {
          if (value[j + 1] === first) {
            j++; // doubled quote — a literal quote, keep scanning
            continue;
          }
          close = j;
          break;
        }
      }
      if (close === -1) {
        // Unterminated quote — malformed (Node's --env-file would error).
        warnings.push(`.noir/.env:${i + 1}: unterminated quoted value — skipped`);
        continue;
      }
      value = value.slice(1, close);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    vars[key] = value; // last definition wins
  }
  return { vars, warnings };
}

export interface LoadedEnv {
  /** Key→value overlay to apply: every non-refused key the file defines. */
  readonly overlay: Record<string, string>;
  readonly warnings: string[];
  /**
   * Provenance of every key that resolves to something, key→winner:
   * `'file'` when `.noir/.env` defines it, `'env'` when the key is only in the
   * ambient environment and the file therefore falls through to it. NAMES ONLY,
   * never a value — this object is renderable by `noir env` / doctor.
   */
  readonly sources: Record<string, 'file' | 'env'>;
}

/**
 * Read `<root>/.noir/.env` (missing = no-op) and compute the overlay to apply:
 * every parsed var the deny-list does not refuse. A key the file defines WINS
 * over `env`; `env` is the fallback for keys the file omits (spec 12.1).
 *
 * A file git TRACKS is refused outright (spec 12.2, see `isGitTracked`): it may
 * have arrived with the clone, and under 12.1 precedence it would be able to
 * redirect credentials that the ambient environment supplies. The refusal is
 * decided BEFORE parsing, so a tracked file's contents are never even read into
 * the overlay — the only thing emitted for it is the remedy.
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
    return { overlay: {}, warnings: [], sources: {} }; // missing file — silent no-op
  }
  // TRACKED-FILE REFUSAL (spec 12.2). Runs before the parse so a repo-supplied
  // file is never interpreted at all — a refused file must not be able to warn
  // about, shadow, or contribute a single key. Same early-return shape as the
  // missing-file no-op (empty overlay), plus the refusal warning.
  if (isGitTracked(root, ENV_FILE_REL_PATH)) {
    return {
      overlay: {},
      warnings: [
        `.noir/.env: refusing to load — it is tracked by git. A cloned repository ` +
          `could redirect credentials through it. Fix: add \`.noir/.env\` to .gitignore ` +
          `(Noir's managed block already does) and run \`git rm --cached .noir/.env\`.`,
      ],
      sources: {},
    };
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
  // PRECEDENCE (spec 12.1): a key this file defines WINS; the real environment
  // is the FALLBACK for keys the file omits. This departs from Node --env-file
  // fill-only-unset deliberately: for PROJECT configuration, the project file
  // must be able to describe the project. `sources` records the winner so
  // `noir env` and doctor can report provenance without re-reading anything.
  const overlay: Record<string, string> = {};
  const sources: Record<string, 'file' | 'env'> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (PROCESS_INJECTION_ENV_RE.test(k)) {
      warnings.push(`.noir/.env: refusing process-injection key '${k}' — ignored`);
      continue;
    }
    if (env[k] !== undefined && env[k] !== v) {
      // Names the KEY only, never a value: stderr is loggable/shareable, and
      // the point is "your shell value is not the one in effect", not a diff.
      warnings.push(
        `.noir/.env: '${k}' overrides the environment value for this run ` +
          `(run \`noir env\` to see every resolved key)`,
      );
    }
    overlay[k] = v;
    sources[k] = 'file';
  }
  // Ambient keys the file does not define are the fallback: they still resolve,
  // so record them as 'env' — `noir env` can then report every resolved key's
  // source without re-reading the environment. Read from the `env` argument
  // only (never the `process.env` global), so this stays as confined as the
  // overlay itself. Process-injection names are skipped on this side too: they
  // are never project configuration, and npm/pnpm export a crowd of
  // `npm_*` keys that would otherwise bury the real ones.
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || sources[k] !== undefined) continue;
    if (PROCESS_INJECTION_ENV_RE.test(k)) continue;
    sources[k] = 'env';
  }
  return { overlay, warnings, sources };
}

/**
 * Load + apply `.noir/.env` to `env` (default `process.env`) in place, warning
 * on malformed lines and on every key whose file value overrides an ambient
 * one. Returns the applied overlay. Idempotent — call once at process start
 * (CLI entry + daemon/serve entry).
 *
 * CONFINEMENT INVARIANT: writes go into the `env` object it is handed and
 * nowhere else — never the `process.env` global. A caller that passes its own
 * object (a child-spawn env, a test) is therefore fully insulated, and a user's
 * manual `claude` invocations are untouched by anything Noir does here.
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
