// ENOENT fallback for `noir run --command <name>`: resolves a command name
// through the user's interactive shell. `child_process.spawn()` cannot see shell
// aliases or functions (they only exist inside an interactive shell that has
// sourced .zshrc/.bashrc/config.fish), and PATH entries exported only in rc
// files are invisible to non-interactive children — both surface as ENOENT.
//
// Safety model (the whole point of this module):
//   - the NAME is validated against a strict charset and passed ONLY via argv
//     ($1), never interpolated into the -c string;
//   - the host's flags + prompt travel only as "$@" / $argv positional
//     parameters, so no user-controlled text ever reaches the shell parser;
//   - the probe is a one-shot lookup with a Node-side timeout killed via the
//     process group (rc files can hang, exit, or spawn orphaned children).
// On Windows the fallback is disabled entirely (cmd/PowerShell aliases are
// session-scoped and unspawnable).

import { spawn } from 'node:child_process';
import { basename } from 'node:path';

const PROBE_TIMEOUT_MS = 3000;
/** Strict command-name charset — anything else is never handed to a shell. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SUPPORTED_SHELLS = new Set(['zsh', 'bash', 'fish']);

export interface ShellBridgeEnv {
  SHELL?: string;
  PATH?: string;
  HOME?: string;
  [key: string]: string | undefined;
}

/** What the probe found for a name, or why it bailed. */
export type ShellResolution =
  | { readonly kind: 'path'; readonly path: string; readonly shell: string }
  | { readonly kind: 'alias'; readonly shell: string }
  | { readonly kind: 'function'; readonly shell: string }
  | { readonly kind: 'none'; readonly shell: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'unsupported' };

export interface ResolveOptions {
  readonly env?: ShellBridgeEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

/**
 * Guard: only plain command names on a POSIX platform with a supported
 * interactive shell (zsh/bash/fish) are eligible for the shell fallback.
 */
export function isEligibleForShellFallback(name: string, opts: ResolveOptions = {}): boolean {
  const { env = process.env, platform = process.platform } = opts;
  if (platform === 'win32') return false;
  if (name.length === 0 || name.includes('/') || !NAME_RE.test(name)) return false;
  const shell = env.SHELL;
  if (!shell || shell.length === 0) return false;
  return SUPPORTED_SHELLS.has(basename(shell).toLowerCase());
}

/** Extract the LAST `N:` (resolved path) and `K:` (kind) sentinel lines. */
export function parseProbeOutput(stdout: string): { path: string; kind: string } {
  let path = '';
  let kind = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('N:')) path = line.slice(2).trim();
    else if (line.startsWith('K:')) kind = line.slice(2).trim();
  }
  return { path, kind };
}

/** Map probe output onto a spawnable outcome (PATH wins over kind). */
export function classifyResolution(
  path: string,
  kind: string,
): 'path' | 'alias' | 'function' | 'none' {
  if (path.trim().startsWith('/')) return 'path';
  const k = kind.trim().toLowerCase();
  if (k.includes('alias')) return 'alias';
  if (k.includes('function')) return 'function';
  return 'none';
}

function shellKind(shell: string): 'zsh' | 'bash' | 'fish' | null {
  const kind = basename(shell).toLowerCase();
  return (SUPPORTED_SHELLS.has(kind) ? kind : null) as 'zsh' | 'bash' | 'fish' | null;
}

/** Login+interactive flags per shell. fish has no separate login mode — `-i -c`
 *  sources config.fish; zsh/bash use `-lic` (login+interactive) so rc files that
 *  only load in login shells (PATH via .zprofile / /etc/zprofile) are visible. */
const PROBE_FLAGS: Record<'zsh' | 'bash' | 'fish', string> = {
  zsh: '-lic',
  bash: '-lic',
  fish: '-ic',
};

/**
 * One-shot probe scripts. The NAME is always read from `$1`/`$argv[1]` (argv),
 * never written into the script. bash login shells skip .bashrc, so it is
 * sourced explicitly (double-source is harmless). stdout noise (rc banners,
 * "no job control") is ignored by sentinel parsing.
 */
const PROBE_SCRIPTS: Record<'zsh' | 'bash' | 'fish', string> = {
  zsh: 'printf "\\nN:%s" "$(whence -p "$1")"; printf "\\nK:%s" "$(whence -w "$1")"',
  bash: 'shopt -s expand_aliases; [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null; printf "\\nN:%s" "$(type -P "$1")"; printf "\\nK:%s" "$(type -t "$1")"',
  fish: 'printf "\\nN:%s" (type -P "$argv[1]"); printf "\\nK:%s" (type -t "$argv[1]")',
};

/** Run the probe; always resolves (never rejects), reporting a timeout. */
function probeCommand(
  name: string,
  shell: string,
  opts: ResolveOptions,
): Promise<{ stdout: string; timedOut: boolean }> {
  const kind = shellKind(shell);
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const script = kind ? PROBE_SCRIPTS[kind] : '';
    const flags = kind ? PROBE_FLAGS[kind] : '-lic';
    // bash/zsh consume a positional `$0` (the `noirbridge` dummy) and read the
    // command name from `$1`; fish has NO `$0` — its positional args ARE `$argv`
    // starting at $argv[1] — so the dummy must be omitted there or $argv[1] would
    // resolve the literal "noirbridge" and the probe would always come back empty.
    const probeArgs = kind === 'fish' ? [name] : ['noirbridge', name];
    const child = spawn(shell, [flags, script, ...probeArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // new process group so the timeout can kill rc-spawned children
      ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.resume(); // rc noise (e.g. "no job control") — ignored
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // orphan guard: group, not just shell
        } catch {
          /* already gone */
        }
      }
      resolve({ stdout, timedOut: true });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut: false });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut: false });
    });
  });
}

/** Cache resolved absolute paths per (shell, name) so repeated runs skip the probe. */
const pathCache = new Map<string, string>();

/**
 * Resolve `name` through the user's interactive shell. Returns `path` for a
 * PATH executable (respawn directly, clean stream-json pipe), `alias`/`function`
 * for shell entities (bridge execution needed), `none` for a genuine miss,
 * `error` for a probe timeout, or `unsupported` when the guards reject.
 */
export async function resolveCommandViaShell(
  name: string,
  opts: ResolveOptions = {},
): Promise<ShellResolution> {
  const { env = process.env } = opts;
  if (!isEligibleForShellFallback(name, opts)) return { kind: 'unsupported' };
  const shell = env.SHELL as string;
  const cached = pathCache.get(`${shell}:${name}`);
  if (cached) return { kind: 'path', path: cached, shell };
  const probe = await probeCommand(name, shell, opts);
  if (probe.timedOut) {
    return {
      kind: 'error',
      message: `shell resolution timed out after ${opts.timeoutMs ?? PROBE_TIMEOUT_MS}ms`,
    };
  }
  const { path, kind } = parseProbeOutput(probe.stdout);
  const cls = classifyResolution(path, kind);
  if (cls === 'path') {
    pathCache.set(`${shell}:${name}`, path);
    return { kind: 'path', path, shell };
  }
  if (cls === 'alias' || cls === 'function') return { kind: cls, shell };
  return { kind: 'none', shell };
}

export interface BridgeSpec {
  readonly binary: string;
  readonly args: readonly string[];
}

/**
 * Build the bridge spawn for an alias/function: run the user's interactive
 * shell and execute `NAME "$@"` (fish: `NAME $argv`). The host's flags + prompt
 * are appended as positional args after the dummy `$0` (`noirbridge`) — they are
 * forwarded verbatim by the shell and never parsed. bash re-sources .bashrc
 * (login shells skip it) so the alias/function defined there is available.
 */
export function buildBridgeArgs(
  name: string,
  hostArgs: readonly string[],
  shell: string,
): BridgeSpec {
  const kind = shellKind(shell) ?? 'zsh';
  if (kind === 'fish') {
    // fish has no `$0`; positional args ARE `$argv` from $argv[1], so no dummy.
    return { binary: shell, args: ['-ic', `${name} $argv`, ...hostArgs] };
  }
  if (kind === 'bash') {
    return {
      binary: shell,
      args: [
        '-lic',
        `shopt -s expand_aliases; [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null; ${name} "$@"`,
        'noirbridge',
        ...hostArgs,
      ],
    };
  }
  return { binary: shell, args: ['-lic', `${name} "$@"`, 'noirbridge', ...hostArgs] };
}
