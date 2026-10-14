/**
 * Agent-loop enforcement rules: the deterministic deny-list the `noir hook`
 * dispatcher evaluates at a host's pre-tool event. Two layers:
 *
 *  - Built-in guards protect Noir's own invariants (the 0600 `.noir/.env`
 *    secrets file and the single-writer `.noir/store/` database). They match a
 *    protected path in a file tool's path field, or, for a Bash-like tool, a
 *    boundary-delimited mention of it in the command, and they normalize `.` /
 *    duplicate separator segments so `.noir/./.env` is not an escape.
 *  - Config rules (`enforcement.deny` in `.noir/config.yml`) are literal
 *    substring matches over the tool input's candidate strings, scoped
 *    optionally to one tool name.
 *
 * Everything here is pure and offline: no host process, no daemon, no I/O.
 */

import { posix } from 'node:path';

export interface DenyRule {
  /** Restrict the rule to one tool name (`Write`, `Bash`, ...). Absent means the
   *  rule applies to every tool. */
  tool?: string;
  /** Literal substring matched against the tool input's candidate strings. */
  pattern: string;
  /** The reason the agent sees when the rule denies the call. */
  reason: string;
}

export interface DenyDecision {
  denied: true;
  reason: string;
}

/** Built-in guards, keyed by the `.noir/` path they protect. */
const BUILTIN_GUARDS: ReadonlyArray<{ target: string; reason: string }> = [
  {
    target: '.noir/.env',
    reason:
      '.noir/.env holds project secrets and is owned by Noir; edit .noir/.env.example and copy values instead',
  },
  {
    target: '.noir/store/',
    reason:
      '.noir/store/ is the single-writer store owned by the daemon; never edit the database files directly',
  },
];

/** True when `candidate` is the path, a path under it, or any ancestor spelling
 *  of it (relative or absolute). `target` with a trailing slash means "this
 *  directory and everything inside it". A plain target means "this exact file".
 *  `posix.normalize` collapses `.` and duplicate separators (and resolves `..`)
 *  so `.noir/./.env`, `.noir//.env`, and `.noir/../.noir/.env` all resolve to
 *  the protected path instead of evading the guard. */
function pathUnder(candidate: string, target: string): boolean {
  const c = posix.normalize(candidate);
  const t = posix.normalize(target).replace(/\/+$/, '');
  if (c === t) return true;
  if (c.endsWith(`/${t}`)) return true;
  if (c.startsWith(`${t}/`)) return true;
  return c.includes(`/${t}/`);
}

/** True when a shell command names the protected path as a shell word: the
 *  path is followed by a boundary (whitespace, quote, redirection, separator,
 *  a `/` for the directory form, or end). `.noir/.env.example` does not match
 *  `.noir/.env` because the next character is a filename byte, not a boundary. */
function commandTouches(command: string, target: string): boolean {
  const clean = target.replace(/\/+$/, '');
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?=[\\s"'$;&|><\`/]|$)`).test(command);
}

/** Pull path-like strings out of a tool input (the fields the file tools use:
 *  `file_path`, `path`, `notebook_path`). Returns only non-empty strings. */
function pathCandidates(toolInput: unknown): string[] {
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  return out;
}

/** Pull the command string out of a Bash-like tool input. */
function commandCandidate(toolInput: unknown): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const input = toolInput as Record<string, unknown>;
  const value = input.command ?? input.cmd;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Evaluate the deny-list against a tool call. Returns a deny decision when a
 * rule matches, else `null` (allow). Pure and total — never throws.
 */
export function evaluateDeny(
  rules: readonly DenyRule[],
  toolName: string,
  toolInput: unknown,
): DenyDecision | null {
  const paths = pathCandidates(toolInput);
  const command = commandCandidate(toolInput);

  for (const guard of BUILTIN_GUARDS) {
    for (const path of paths) {
      if (pathUnder(path, guard.target)) return { denied: true, reason: guard.reason };
    }
    if (command !== undefined && commandTouches(command, guard.target)) {
      return { denied: true, reason: guard.reason };
    }
  }

  const candidates = [...paths];
  if (command) candidates.push(command);
  if (candidates.length === 0) {
    // No recognized field — match against the whole serialized input so a rule
    // can still target an unfamiliar tool shape.
    candidates.push(JSON.stringify(toolInput ?? ''));
  }

  for (const rule of rules) {
    if (rule.tool && rule.tool !== toolName) continue;
    for (const candidate of candidates) {
      if (candidate.includes(rule.pattern)) return { denied: true, reason: rule.reason };
    }
  }

  return null;
}
