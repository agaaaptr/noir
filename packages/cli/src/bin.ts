// `noir` bin entry. Migrated from the hand-rolled `parseArgs` dispatcher onto a
// commander Command tree (S9 t1). Behavior of init / sync / mcp serve / daemon
// start|stop / doctor is preserved flag-for-flag; the only change is the dispatch
// path and the new global flags + exit-code contract.
//
// Testability: commander is configured with `.exitOverride()` so it NEVER calls
// `process.exit`. The exported `createProgram()` factory returns a fresh, fully
// wired program for unit tests; `run(argv)` is the bin's own entry and maps any
// thrown error to `process.exitCode` (Node then exits naturally with that code).
// A main-module guard prevents auto-running when bin.ts is imported by tests.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type HostId, SUPPORTED_HOSTS } from '@noir-ai/adapters';
import { NOIR_VERSION } from '@noir-ai/core';
import { Command, Option } from 'commander';
import { contextIndex, contextSearch, contextStatus } from './commands/context.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop } from './commands/daemon.js';
import { doctor } from './commands/doctor.js';
import { type HandoffOptions, handoff } from './commands/handoff.js';
import { type HomeDeps, home } from './commands/home.js';
import {
  memoryConsolidate,
  memoryForget,
  memoryRecall,
  memorySave,
  memorySessions,
} from './commands/memory.js';
import { skillsList, skillsSync } from './commands/skills.js';
import { type StatusOptions, status } from './commands/status.js';
import { taskAdvance, taskNew, taskNext, taskStatus } from './commands/task.js';
import { init } from './init.js';
import {
  type CliOptions,
  EXIT,
  fail,
  handleError,
  inferExitCode,
  json,
  NoirCliError,
  requireInteractive,
  tip,
} from './output.js';
import { serve } from './serve.js';
import { buildPaletteCommands } from './tui/commands/registry.js';
import type { PaletteCommand } from './tui/palette/types.js';

// Exit-code contract, error type, `fail`, and exit-code mapping live in
// `./output.js` (S9 t2 central output infra). Re-exported here so existing
// imports from `./bin.js` (bin.test.ts, future commands) keep working without
// a second source of truth.
export { EXIT, fail, inferExitCode, NoirCliError };

/**
 * The TUI palette source (B3). Walks a FRESH {@link createProgram} at `noir tui`
 * launch and projects every leaf subcommand into a {@link PaletteCommand}.
 * Defined here (not in the tui) so the palette derives from the REAL command
 * tree without the tui graph importing the bin (which would be circular).
 */
export function buildPaletteCommandsForTui(): PaletteCommand[] {
  return buildPaletteCommands(createProgram());
}

// ---------------------------------------------------------------------------
// Program factory. Each call returns a fresh, independently-parseable Command
// (commander parse state is mutable, so tests should drive a fresh program).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Action-option bridge. Commander passes each action handler the positional
// args + options + the action's Command as the LAST argument. The global flags
// (`--json/--no-input/--quiet/--verbose/--cwd`, registered `` on
// the program) land on `command.optsWithGlobals()`. The two helpers below read
// those globals off the trailing Command without depending on how many params
// commander injected in front of it (it varies with the command's arity), so a
// single pattern works for every action.
// ---------------------------------------------------------------------------
function actionGlobals(args: readonly unknown[]): Record<string, unknown> {
  // `noUncheckedIndexedAccess` → element access yields `unknown`; the optional
  // chain + cast handles the undefined case without a runtime branch.
  const last = args[args.length - 1];
  return (last as Command | undefined)?.optsWithGlobals() ?? {};
}

/**
 * The trailing {@link Command} commander always passes as the LAST action
 * argument. Used by the context/memory/task actions to read their own options
 * (`cmd.opts()`) + globals (`cmd.optsWithGlobals()`) without depending on how
 * many positional args commander injected in front of it. Positional values are
 * read off the FRONT of `args` (commander puts positionals first, then the
 * options object, then the command). Throws on a malformed call rather than
 * silently coercing `undefined`.
 */
function trailingCmd(args: readonly unknown[]): Command {
  const last = args[args.length - 1];
  if (!(last instanceof Command)) {
    throw new NoirCliError(
      EXIT.ERROR,
      'internal: commander action callback received no trailing Command',
    );
  }
  return last;
}

/** Map commander's parsed global-flag bag onto the CLI's {@link CliOptions}. */
function toCliOptions(g: Record<string, unknown>): CliOptions {
  // `--no-input` is stored under `input` (commander strips the `no-` prefix);
  // default `true`, so `input !== false` ⇒ input allowed.
  return {
    json: g.json === true,
    quiet: g.quiet === true,
    verbose: g.verbose === true,
    input: g.input !== false,
    // TUI policy — additive only. `--tui`/`--no-tui` land on `tui`
    // (true/false; absent when neither flag is given). Spread conditionally so
    // the default-args case (no flag) does NOT add a `tui` key — keeps the
    // exact-shape assertions in bin.test.ts green.
    ...(g.tui === true || g.tui === false ? { tui: g.tui === true } : {}),
    // `--no-tips` is stored under `tips` (default true; flag ⇒ false). Map to
    // the additive `noTips` spelling used by CliOptions + `tip()`.
    ...(g.tips === false ? { noTips: true } : {}),
  };
}

/** {@link toCliOptions} + the daemon-client knobs `status` needs. */
function toStatusOptions(g: Record<string, unknown>): StatusOptions {
  return {
    json: g.json === true,
    quiet: g.quiet === true,
    verbose: g.verbose === true,
    input: g.input !== false,
  };
}

/**
 * S10 — narrow commander's `string | undefined` host option to `HostId |
 * undefined`. Commander's `.choices(SUPPORTED_HOSTS)` already rejects unknown
 * values at parse time (usage=2), so by the time the action runs any string
 * present IS one of `SUPPORTED_HOSTS`. The cast is therefore total — but kept
 * explicit (not a type assertion) so a future change to the choices wiring
 * surfaces here rather than silently coercing. Returns `undefined` for an
 * unset flag so callers can conditional-spread (preserves the exact-arg-shape
 * assertions in bin.test.ts).
 */
function parseHost(raw: string | undefined): HostId | undefined {
  if (raw === undefined) return undefined;
  // The cast is safe: commander's `.choices` enforces it pre-action.
  return raw as HostId;
}

// ---------------------------------------------------------------------------
// TUI policy + deprecation / redirect infrastructure.
//
// Approach B (locked): TUI-primary UX, but NEVER hard-gate any subcommand. The
// bare `noir` home menu is the documented human entry point; every subcommand
// stays 100% scriptable. `--json` is the headless contract. The deprecation
// registry below is the formal "warn for N → redirect for N → never silently
// remove" channel; ZERO entries today (no command is deprecated).
// ---------------------------------------------------------------------------

/** One entry in the {@link DEPRECATIONS} registry. */
export interface DeprecationEntry {
  /** Old command form as a path prefix, e.g. `['legacy-status']` or
   *  `['context','legacy']`. Matched against the dispatched command's path
   *  (program name `noir` stripped). */
  readonly oldArgv: readonly string[];
  /** Replacement command form, e.g. `['status']`. Shown in the redirect hint. */
  readonly newArgv: readonly string[];
  /** Version the deprecation started in, e.g. `'1.4.0'`. */
  readonly since: string;
}

/**
 * Deprecation registry. **Empty today** — no `noir` command is deprecated.
 * When adding an entry, update the CHANGELOG + `docs/reference/cli.md` (and,
 * if the old form still routes, add a redirect). {@link emitDeprecationHintsFor}
 * scans this on every dispatch and emits one `tip()` per match; `--no-tips` /
 * `--json` suppress the hint (see {@link tip}).
 */
export const DEPRECATIONS: DeprecationEntry[] = [];

/**
 * Build the dispatched command's path (e.g. `['noir','context','search']`) by
 * walking `.parent` up to the program root. Used by {@link emitDeprecationHintsFor}
 * to match an {@link DeprecationEntry.oldArgv} prefix (program name stripped).
 */
function commandPath(cmd: Command): string[] {
  const path: string[] = [];
  let c: Command | null = cmd;
  while (c !== null) {
    path.unshift(c.name());
    c = c.parent;
  }
  return path;
}

/**
 * Emit one redirect hint per matching {@link DEPRECATIONS} entry for the
 * dispatched command. Respects `--no-tips` and `--json` via {@link tip} (a CI
 * run's stderr stays quiet and its stdout envelope stays pristine). Exported so
 * tests can drive it with a temporarily-populated registry without going
 * through commander.
 */
export function emitDeprecationHintsFor(cmd: Command, opts: CliOptions): void {
  if (DEPRECATIONS.length === 0) return; // common case (no entries today)
  // Strip the leading program name ('noir') for matching.
  const rel = commandPath(cmd).slice(1);
  for (const d of DEPRECATIONS) {
    if (d.oldArgv.every((a, i) => rel[i] === a)) {
      tip(
        `\`noir ${d.oldArgv.join(' ')}\` is deprecated since v${d.since}; use \`noir ${d.newArgv.join(' ')}\`.`,
        opts,
      );
    }
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('noir')
    .description('Noir — discipline, context, and memory layer for agentic CLIs.')
    .version(NOIR_VERSION, '-v, --version')
    // Global flags (S9). makeGlobal() propagates each to every subcommand so
    // they parse in any position (e.g. `noir status --json` as well as `noir
    // --json status`) and appear on subcommand --help.
    .addOption(new Option('--json', 'emit machine-readable JSON to stdout'))
    .addOption(new Option('--no-input', 'never prompt; error if input is required'))
    .addOption(new Option('--quiet', 'suppress non-essential diagnostics'))
    .addOption(new Option('--verbose', 'show additional diagnostic detail'))
    .addOption(new Option('--cwd <path>', 'run as if started in <path>'))
    // TUI policy — advisory routing for bare `noir` only (never hard-gates a
    // subcommand). `--tui`/`--no-tui` are a commander negatable pair: parsed
    // onto a single `tui` attribute (true / false / absent=auto). Bare `noir`
    // in a TTY runs the home menu by default; `--no-tui` forces the
    // non-interactive `status` path even in a TTY; `--tui` is a hint that still
    // requires a TTY (so it never blocks in CI / a pipe). See home.ts + CLAUDE.md.
    .addOption(
      new Option('--tui', 'prefer the interactive home menu for bare `noir` (advisory; TTY-only)'),
    )
    .addOption(
      new Option(
        '--no-tui',
        'route bare `noir` to the non-interactive `status` path even in a TTY',
      ),
    )
    // Deprecation / redirect hints — `--no-tips` silences the `tip()` helper
    // for CI / log-friendly runs. No command is deprecated today; the flag is
    // the headless contract for quieting future notices.
    .addOption(new Option('--no-tips', 'suppress redirect / deprecation hints on stderr'))
    .exitOverride((err) => {
      // Never process.exit; surface to the caller (run()/test) instead.
      throw err;
    })
    .configureOutput({
      // Stream discipline: --help/--version → stdout (conventional; users pipe
      // them), errors → stderr. --json data is emitted by command actions via
      // process.stdout directly, NOT by commander's writeOut, so routing help/
      // version to stdout does not conflict with --json payloads.
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    });

  // --cwd: chdir before the action runs so the existing modules (which read
  // process.cwd()) honor it. actionCmd.optsWithGlobals() works on whichever
  // program instance is being parsed, so createProgram() isolates correctly.
  program.hook('preAction', (_thisCmd, actionCmd) => {
    const opts = actionCmd.optsWithGlobals();
    const cwd = opts.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) {
      try {
        process.chdir(cwd);
      } catch (err) {
        throw new NoirCliError(
          EXIT.USAGE,
          `--cwd: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // SP-G: propagate --json / --no-input to the deep conflict resolver via env
    // so a regenerate conflict never prompts under those flags (the @clack
    // prompt writes to stdout — it would corrupt --json output and violate
    // --no-input). Done here centrally so init/create/sync need no arg changes
    // (no bin.test.ts arg-pin cascade). buildConflictOpts reads this flag.
    const nonInteractive = opts.json === true || opts.input === false;
    if (nonInteractive) process.env.NOIR_NON_INTERACTIVE = '1';
    else delete process.env.NOIR_NON_INTERACTIVE;
    // Deprecation / redirect hints. Scans {@link DEPRECATIONS} against the
    // dispatched command path; emits via `tip()` (suppressed by --no-tips /
    // --json). Empty registry today — no-op until an entry is added.
    emitDeprecationHintsFor(actionCmd, toCliOptions(opts));
  });

  // ----- migrated commands (behavior-preserving) -----

  program
    .command('init')
    .description('scaffold Noir in the current project (.noir/, .mcp.json, CLAUDE.md, skills)')
    .option('--transport <transport>', 'stdio | streamable-http (default: stdio)', 'stdio')
    .option('--url <url>', 'streamable-http daemon URL (localhost only)')
    .option(
      '--upgrade',
      'run scaffold migrations before re-emitting (re-run on an existing project)',
    )
    .option('--force', 're-scaffold even if already initialized (bypasses the already-init no-op)')
    .option('--dry-run', 'report planned writes without writing anything')
    .option('--preview', 'alias for --dry-run')
    .addOption(
      // S10: target host. Defaults to `'claude'` (the regression anchor). The
      // chosen host is forwarded to scaffold() + skills emission via
      // resolveAdapter. The choice list mirrors `SUPPORTED_HOSTS` so a new host
      // lands here automatically; commander rejects anything else as usage=2.
      new Option(
        '--host <id>',
        'target agentic CLI (default: claude) — drives host-side emission',
      ).choices(SUPPORTED_HOSTS),
    )
    .action(
      async (
        opts: {
          transport?: string;
          url?: string;
          upgrade?: boolean;
          force?: boolean;
          host?: string;
          dryRun?: boolean;
          preview?: boolean;
        },
        cmd: Command,
      ) => {
        // Preserve the parseArgs coercion exactly: only 'streamable-http' is
        // special; any other value (incl. typos / future transports) → 'stdio'.
        const transport: 'stdio' | 'streamable-http' =
          opts.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
        // `upgrade`/`host` are conditionally spread so an UNSET flag does NOT add
        // an `upgrade: false` / `host: …` key to the opts object — that would
        // break the toEqual-based arg assertions in bin.test.ts (which expects
        // exactly `{transport, url}` for the default-invocation cases). Matches
        // the conditional-spread pattern used for task/memory options elsewhere.
        const upgrade = opts.upgrade === true;
        const force = opts.force === true;
        const host = parseHost(opts.host);
        // F1: --dry-run/--preview collapse to a single dryRun boolean (the
        // command modules read both spellings, but the bin normalizes).
        const dryRun = opts.dryRun === true || opts.preview === true;
        const result = await init(process.cwd(), {
          transport,
          url: opts.url,
          ...(upgrade ? { upgrade } : {}),
          ...(force ? { force } : {}),
          ...(host !== undefined ? { host } : {}),
          ...(dryRun ? { dryRun } : {}),
        });
        // ScaffoldResult gap close: surface the structured ScaffoldResult (with
        // `conflicts[]`) on stdout under `--json`, wrapped in the versioned
        // `{ok, data}` envelope so it matches the headless contract every read
        // command uses. The args passed to init() are UNCHANGED (bin.test.ts
        // arg pins still hold); only the return value is captured + emitted.
        // `init` returns `undefined` on the already-initialized no-op — skip.
        if (cmd.optsWithGlobals().json === true && result !== undefined) {
          json({ ok: true, data: result });
        }
      },
    );

  // `noir create [dir]` — greenfield AI-layer bootstrap (slice S). Lazy import
  // mirrors sync's dispatcher so the create module isn't loaded for unrelated
  // commands. Optional `[dir]` defaults to process.cwd() inside the action.
  program
    .command('create [dir]')
    .description('bootstrap the Noir AI layer in a new or empty directory')
    .option('--transport <transport>', 'stdio | streamable-http (default: stdio)', 'stdio')
    .option('--url <url>', 'streamable-http daemon URL (localhost only)')
    .option('--force', 're-scaffold even if already initialized (bypasses the already-init no-op)')
    .option('--dry-run', 'report planned writes without writing anything')
    .option('--preview', 'alias for --dry-run')
    .addOption(
      new Option(
        '--host <id>',
        'target agentic CLI (default: claude) — drives host-side emission',
      ).choices(SUPPORTED_HOSTS),
    )
    .action(
      async (
        dir: string | undefined,
        opts: {
          transport?: string;
          url?: string;
          force?: boolean;
          host?: string;
          dryRun?: boolean;
          preview?: boolean;
        },
        cmd: Command,
      ) => {
        const transport: 'stdio' | 'streamable-http' =
          opts.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
        const force = opts.force === true;
        const host = parseHost(opts.host);
        // F1: --dry-run/--preview collapse to a single dryRun boolean.
        const dryRun = opts.dryRun === true || opts.preview === true;
        const { create } = await import('./commands/create.js');
        const result = await create(dir, {
          transport,
          url: opts.url,
          ...(force ? { force } : {}),
          ...(host !== undefined ? { host } : {}),
          ...(dryRun ? { dryRun } : {}),
        });
        // ScaffoldResult gap close: surface the structured ScaffoldResult (with
        // `conflicts[]`) on stdout under `--json`, wrapped in the `{ok, data}`
        // envelope (headless contract). Skipped on the no-op return.
        if (cmd.optsWithGlobals().json === true && result !== undefined) {
          json({ ok: true, data: result });
        }
      },
    );

  program
    .command('sync')
    .description(
      're-emit Noir managed files (.mcp.json, CLAUDE.md blocks, NOIR.md brief, ignores) + skills',
    )
    .option(
      '--force',
      'overwrite differing regenerated files without prompting (bypasses the conflict menu)',
    )
    .option(
      '--merge',
      'three-way merge managed regions (default since 1.3.0; flag kept for compatibility)',
    )
    .option('--dry-run', 'report planned writes without writing anything')
    .option('--preview', 'alias for --dry-run')
    .addOption(
      // Opt OUT of managed-region merge (restore strip-replace). Commander
      // stores `--no-merge-regions` under `mergeRegions` (default true; flag →
      // false). Bare `noir sync` keeps the merge default (true).
      new Option(
        '--no-merge-regions',
        'strip-replace managed regions (discard hand-edits inside <!-- noir:* --> markers)',
      ),
    )
    .addOption(
      // S10: optional `--host` override. When omitted, sync reads host from
      // `.noir/config.yml` (whatever `noir init --host <id>` persisted). The
      // override is rarely needed — documented as advanced.
      new Option(
        '--host <id>',
        'override the configured host (advanced; default reads .noir/config.yml)',
      ).choices(SUPPORTED_HOSTS),
    )
    .action(
      async (
        opts: {
          host?: string;
          force?: boolean;
          merge?: boolean;
          mergeRegions?: boolean;
          dryRun?: boolean;
          preview?: boolean;
        },
        cmd: Command,
      ) => {
        // Lazy import preserves the original dispatcher's deferred module load.
        const { sync } = await import('./sync.js');
        const host = parseHost(opts.host);
        const force = opts.force === true;
        const merge = opts.merge === true;
        // `--no-merge-regions` → commander stores `mergeRegions: false`.
        const noMergeRegions = opts.mergeRegions === false;
        // F1: --dry-run/--preview collapse to a single dryRun boolean.
        const dryRun = opts.dryRun === true || opts.preview === true;
        // Single-positional regression anchor: when no `--host`/`--force`/`--merge`/
        // `--no-merge-regions`/`--dry-run` is given, call `sync(cwd)` exactly
        // (bin.test.ts pins this). Only spread the opts bag when a flag was
        // explicit so the default-args snapshot stays green.
        const result =
          host === undefined && !force && !merge && !noMergeRegions && !dryRun
            ? await sync(process.cwd())
            : await sync(process.cwd(), {
                ...(host !== undefined ? { host } : {}),
                ...(force ? { force } : {}),
                ...(merge ? { merge } : {}),
                ...(noMergeRegions ? { mergeManagedRegions: false } : {}),
                ...(dryRun ? { dryRun } : {}),
              });
        // ScaffoldResult gap close: surface the structured ScaffoldResult (with
        // `conflicts[]`) on stdout under `--json`, wrapped in the `{ok, data}`
        // envelope (headless contract). sync() always returns a ScaffoldResult
        // (never undefined), so the guard is the json flag only.
        if (cmd.optsWithGlobals().json === true) {
          json({ ok: true, data: result });
        }
      },
    );

  // `mcp` group — preserve legacy bare-`mcp` usage error.
  const mcpCmd = program.command('mcp').description('MCP server control');
  mcpCmd
    .command('serve')
    .description('run the Noir MCP server (stdio, or via the shared daemon)')
    .option('--stdio', 'force the stdio transport')
    .action(async (opts: { stdio?: boolean }) => {
      await serve({ stdio: opts.stdio === true });
    });
  mcpCmd.action(() => {
    throw new NoirCliError(EXIT.USAGE, 'Usage: noir mcp serve [--stdio]');
  });

  // `daemon` group — start/stop/status/restart (S9).
  // `start` runs the daemon in the FOREGROUND by default; `--detach` forks a
  // detached child (D1). `--_detached-child` is the hidden marker the detached
  // child carries (D2): it tells the child it IS the daemon (run in-process),
  // so it is never shown in `--help` and never meant for users.
  const daemonGrp = program.command('daemon').description('control the Noir daemon');
  daemonGrp
    .command('start')
    .description('start the Noir daemon (foreground, or background with --detach)')
    .option('--detach', 'run the daemon in the background and exit')
    .addOption(
      new Option('--_detached-child', 'reserved: detached daemon child (internal)').hideHelp(),
    )
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const detach = g.detach === true;
      const detachChild = g._detachedChild === true;
      await daemonStart({
        ...toCliOptions(g),
        ...(detach ? { detach } : {}),
        ...(detachChild ? { detachChild } : {}),
      });
    });
  daemonGrp
    .command('stop')
    .description('stop the Noir daemon')
    .action(async (...args: unknown[]) => {
      await daemonStop(toCliOptions(trailingCmd(args).optsWithGlobals()));
    });
  daemonGrp
    .command('status')
    .description('report daemon pid/uptime/mode (exit 4 if not running)')
    .action(async (...args: unknown[]) => {
      await daemonStatus(toCliOptions(trailingCmd(args).optsWithGlobals()));
    });
  daemonGrp
    .command('restart')
    .description('stop then start the daemon')
    .action(async (...args: unknown[]) => {
      await daemonRestart(toCliOptions(trailingCmd(args).optsWithGlobals()));
    });
  daemonGrp.action(() => {
    throw new NoirCliError(EXIT.USAGE, 'Usage: noir daemon start|stop|status|restart');
  });

  program
    .command('doctor')
    .description('environment + project health')
    .option(
      '--dedup',
      'scan host-context + .noir/ docs for semantic near-duplicates (loads the local embedder)',
    )
    .action(async (...args: unknown[]) => {
      const g = actionGlobals(args);
      const dedup = trailingCmd(args).opts().dedup === true;
      await doctor({ ...toCliOptions(g), ...(dedup ? { dedup: true } : {}) });
    });

  // ----- new subcommand groups (wired by t4) -----
  // Signatures match S9 §7 so --help is accurate; every action dispatches to
  // its command module in ./commands/*.js.

  program
    .command('status')
    .description('project + daemon + workflow + store snapshot')
    .action(async (...args: unknown[]) => {
      // Global flags (`--json`/`--verbose`/…) reach status via the trailing
      // Command; the action itself owns no command-specific options.
      await status(toStatusOptions(actionGlobals(args)));
    });

  const contextGrp = program.command('context').description('context engine (S6)');
  contextGrp
    .command('search')
    .description('hybrid search over the indexed context')
    .argument('<query>', 'search query')
    .option('--limit <n>', 'max results', '10')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      // Positional `<query>` is always the leading action arg.
      const query = typeof args[0] === 'string' ? (args[0] as string) : '';
      const limit = typeof g.limit === 'string' ? (g.limit as string) : undefined;
      await contextSearch({
        ...toCliOptions(g),
        query,
        ...(limit === undefined ? {} : { limit }),
      });
    });
  contextGrp
    .command('index')
    .description('(re)index project files into the context store')
    // Repeatable: the `(val, acc) => [...acc, val]` coercion accumulates each
    // `--path` into an array (commander's idiomatic collect pattern), so
    // `--path a --path b` → `['a','b']` instead of last-wins.
    .option(
      '--path <p>',
      'path to index (repeatable)',
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option('--force', 'ignore content-hash caching (recognized; not yet honored)')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const rawPaths = Array.isArray(g.path)
        ? (g.path as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      const force = g.force === true;
      await contextIndex({
        ...toCliOptions(g),
        ...(rawPaths.length === 0 ? {} : { paths: rawPaths }),
        ...(force ? { force } : {}),
      });
    });
  contextGrp
    .command('status')
    .description('index freshness + counts')
    .action(async (...args: unknown[]) => {
      await contextStatus(toCliOptions(trailingCmd(args).optsWithGlobals()));
    });
  contextGrp.action(() => {
    throw new NoirCliError(EXIT.USAGE, 'Usage: noir context search|index|status');
  });

  const memoryGrp = program.command('memory').description('memory engine');
  memoryGrp
    .command('recall')
    .description('recall memories for a query')
    .argument('<query>', 'recall query')
    .option('--limit <n>', 'max results', '10')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const query = typeof args[0] === 'string' ? (args[0] as string) : '';
      const limit = typeof g.limit === 'string' ? (g.limit as string) : undefined;
      await memoryRecall({
        ...toCliOptions(g),
        query,
        ...(limit === undefined ? {} : { limit }),
      });
    });
  memoryGrp
    .command('save')
    .description('save an observation to long-term memory')
    // Both optional: `--content` is prompted interactively when absent (memory.ts),
    // or the command fails exit 2 under non-interactive / --no-input / --json.
    .option('--content <text>', 'memory content (prompted interactively if omitted)')
    .option(
      '--type <type>',
      'observation type (pattern | preference | architecture | bug | workflow | fact | decision)',
    )
    .option('--files <files>', 'comma-separated related file paths')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const content = typeof g.content === 'string' ? (g.content as string) : undefined;
      const type = typeof g.type === 'string' ? (g.type as string) : undefined;
      const files = typeof g.files === 'string' ? (g.files as string) : undefined;
      await memorySave({
        ...toCliOptions(g),
        ...(content === undefined ? {} : { content }),
        ...(type === undefined ? {} : { type }),
        ...(files === undefined ? {} : { files }),
      });
    });
  memoryGrp
    .command('sessions')
    .description('list recent memory sessions')
    .action(async (...args: unknown[]) => {
      await memorySessions(toCliOptions(trailingCmd(args).optsWithGlobals()));
    });
  memoryGrp
    .command('forget')
    .description('delete one or more memories by id')
    .argument('<ids...>', 'observation id(s)')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      // Variadic positional → commander passes a string[] as the leading arg.
      const rawIds = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
      const ids = rawIds.filter((x): x is string => typeof x === 'string');
      await memoryForget({ ...toCliOptions(g), ids });
    });
  memoryGrp
    .command('consolidate')
    .description('consolidate memories into a derived lesson (provider-explicit)')
    .option('--types <types>', 'comma-separated observation types to consolidate')
    .option('--limit <n>', 'cap on candidate observations')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const types = typeof g.types === 'string' ? (g.types as string) : undefined;
      const limit = typeof g.limit === 'string' ? (g.limit as string) : undefined;
      await memoryConsolidate({
        ...toCliOptions(g),
        ...(types === undefined ? {} : { types }),
        ...(limit === undefined ? {} : { limit }),
      });
    });
  memoryGrp.action(() => {
    throw new NoirCliError(
      EXIT.USAGE,
      'Usage: noir memory recall|save|sessions|forget|consolidate',
    );
  });

  // `skills` group — list/sync the builtin pack in-process (S9, S5).
  const skillsGrp = program.command('skills').description('builtin skills (S5)');
  skillsGrp
    .command('list')
    .description('list installed Noir skills')
    .action(async (...args: unknown[]) => {
      await skillsList(toCliOptions(actionGlobals(args)));
    });
  skillsGrp
    .command('sync')
    .description('re-emit skills to the host skills dir')
    .action(async (...args: unknown[]) => {
      await skillsSync(toCliOptions(actionGlobals(args)));
    });
  skillsGrp.action(() => {
    throw new NoirCliError(EXIT.USAGE, 'Usage: noir skills list|sync');
  });

  const taskGrp = program.command('task').description('workflow task control');
  taskGrp
    .command('new')
    .description('start a new workflow task')
    .requiredOption('--slug <slug>', 'task slug')
    .option('--mode <mode>', 'full | quick')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const slug = typeof g.slug === 'string' ? (g.slug as string) : '';
      const mode = typeof g.mode === 'string' ? (g.mode as string) : undefined;
      await taskNew({
        ...toCliOptions(g),
        slug,
        ...(mode === undefined ? {} : { mode }),
      });
    });
  taskGrp
    .command('status')
    .description('active (or named) task status')
    .argument('[id]', 'task id (defaults to active)')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      // Optional positional: only a string at args[0] is the task id.
      const first = args[0];
      const id = typeof first === 'string' ? first : undefined;
      await taskStatus({
        ...toCliOptions(g),
        ...(id === undefined ? {} : { id }),
      });
    });
  taskGrp
    .command('advance')
    .description('advance the active task to the next phase')
    .option('--to <phase>', 'target phase')
    .option('--force <reason>', 'force the gate with a reason')
    .action(async (...args: unknown[]) => {
      const cmd = trailingCmd(args);
      const g = cmd.optsWithGlobals();
      const to = typeof g.to === 'string' ? (g.to as string) : undefined;
      const force = typeof g.force === 'string' ? (g.force as string) : undefined;
      await taskAdvance({
        ...toCliOptions(g),
        ...(to === undefined ? {} : { to }),
        ...(force === undefined ? {} : { force }),
      });
    });
  taskGrp
    .command('next')
    .description('suggest the next phase + applicable skill')
    .action(async (...args: unknown[]) => {
      await taskNext(toCliOptions(trailingCmd(args).optsWithGlobals()));
    });
  taskGrp.action(() => {
    throw new NoirCliError(EXIT.USAGE, 'Usage: noir task new|status|advance|next');
  });

  // C1 -- `noir install` / `noir migrate`: move to the native install path,
  // preserving all settings. `migrate` is an alias (mirrors claude migrate-installer).
  const installCmd = program
    .command('install')
    .description(
      'install Noir via the native managed-Node path (or migrate from another install method)',
    )
    .option('--list', 'list detected install methods')
    .option('--uninstall-prev', 'after a successful migrate, uninstall the previous install method')
    .option(
      '--dismiss',
      'dismiss the migration banner for the current version (persists in install.json)',
    )
    .argument('[spec]', "channel ('latest'|'beta') or exact version (default: latest)")
    .action(
      async (
        spec: string | undefined,
        opts: { list?: boolean; uninstallPrev?: boolean; dismiss?: boolean },
        cmd: Command,
      ) => {
        const { install } = await import('./commands/install.js');
        const cli = cmd.optsWithGlobals() as CliOptions;
        await install({
          ...cli,
          spec,
          list: opts.list === true,
          uninstallPrev: opts.uninstallPrev === true,
          dismiss: opts.dismiss === true,
        });
      },
    );
  // `migrate` alias -- same behavior.
  installCmd.alias('migrate');

  // C1 --- `noir update`: self-update via the active install method.
  program
    .command('update')
    .description('update Noir to the latest version via the active install method')
    .option('--check', 'check for a new version without changing anything')
    .argument('[spec]', "channel ('latest'|'beta') or exact version (default: latest)")
    .action(async (spec: string | undefined, opts: { check?: boolean }, cmd: Command) => {
      const { update } = await import('./commands/update.js');
      const cli = cmd.optsWithGlobals() as CliOptions;
      await update({ ...cli, spec, check: opts.check === true });
    });

  // `noir handoff` + the `noir wrap` session-end alias. Both dispatch the
  // SAME handler; the artifact reuses `gatherStatusPayload` (status.ts) +
  // `PHASE_SKILL` (task.ts) for the snapshot, does a bounded context/memory
  // extraction, and renders a pasteable host-handoff markdown block to STDOUT.
  // `--write` persists to `.noir/handoff/<id>.md` (gitignored); `--json` emits
  // the structured payload. Doctrine: the host-launch directive is TEXT ONLY —
  // Noir never spawns the host.
  function buildHandoffOptions(g: Record<string, unknown>): HandoffOptions {
    return { ...toCliOptions(g), ...(g.write === true ? { write: true } : {}) };
  }
  program
    .command('handoff')
    .description('emit a ready-to-paste host handoff prompt')
    .option('--write', 'persist to .noir/handoff/<id>.md (gitignored)')
    .action(async (...args: unknown[]) => {
      await handoff(buildHandoffOptions(trailingCmd(args).optsWithGlobals()));
    });
  // `noir wrap` — session-end alias (same handler, friendlier name at the end of
  // a session). Same options; no separate code path.
  program
    .command('wrap')
    .description('session-end alias for `noir handoff`')
    .option('--write', 'persist to .noir/handoff/<id>.md (gitignored)')
    .action(async (...args: unknown[]) => {
      await handoff(buildHandoffOptions(trailingCmd(args).optsWithGlobals()));
    });

  // `noir tui` — the interactive Ink dashboard. LAZY-loaded: the Ink app
  // (React) is imported ONLY inside this action via `await import('./tui/…')`,
  // so React + Ink never enter the main CLI startup path. `noir status`,
  // `noir doctor`, a bare `noir`, etc. stay fast and React-free. The dispatch
  // seam is the SAME shape `home(opts, deps)` uses (a fresh commander program
  // per dispatch, with its own error → exit-code mapping) — command routing is
  // NOT reimplemented in the TUI; `/`-prefixed inputs are routed through it.
  // Interactive-only: requires a TTY; under `--json` / `--no-input` / non-TTY
  // / CI / NO_COLOR it errors cleanly via `requireInteractive` (exit 2).
  program
    .command('tui')
    .description('interactive Ink dashboard (host · phase · daemon + /command dispatch)')
    .action(async (...args: unknown[]) => {
      const g = actionGlobals(args);
      const opts = toCliOptions(g);
      // requireInteractive honors all the non-interactive conditions (no TTY,
      // --no-input, --json, CI, NO_COLOR) and fails exit 2 with a clear message.
      requireInteractive(opts, '`noir tui`');
      // LAZY load the Ink dashboard. The import path is computed at runtime
      // (not a string literal) so esbuild cannot statically follow it into the
      // tui graph during the bin build — that static analysis is what hoists
      // bin.ts's entry body (incl. the `isMainModule` realpath guard) into a
      // shared chunk, turning dist/bin.js into a facade and breaking a global
      // `noir` install under its symlink. The tui is built as a sibling entry
      // (see the second tsup config) so its react/ink dependency tree never
      // enters the main CLI graph; React stays out of `noir status` etc.
      const tuiUrl = new URL('./tui/index.js', import.meta.url).href;
      const { runTui } = await import(/* @vite-ignore */ tuiUrl);
      // Same dispatch seam as homeDeps.dispatch above — a fresh program per
      // dispatched argv, errors mapped to process.exitCode (never thrown out).
      const dispatch = async (argv: readonly string[]): Promise<void> => {
        const sub = createProgram();
        try {
          await sub.parseAsync([...argv], { from: 'user' });
        } catch (err) {
          handleError(err);
        }
      };
      await runTui(opts, dispatch);
    });

  // Bare `noir` (no subcommand): the home router (S9 t4). Interactive TTY →
  // @clack menu; non-interactive → `status` (human) or `status --json`
  // (machine). `dispatch` re-parses a fresh program so home/menu actions inherit
  // own their own exit codes. status is probe-only: bare
  // `noir` in CI never auto-starts a daemon and exits 0 even when down.
  const homeDeps: HomeDeps = {
    dispatch: async (argv: readonly string[]): Promise<void> => {
      const sub = createProgram();
      try {
        await sub.parseAsync([...argv], { from: 'user' });
      } catch (err) {
        // Map the sub-command's failure to process.exitCode (never throw out
        // of dispatch — home returns and the outer program exit reflects this).
        handleError(err);
      }
    },
  };
  program.action(async (...args: unknown[]) => {
    const cmd = trailingCmd(args);
    // Bare `noir` (no subcommand) → the home router. But a leftover positional
    // here is an UNKNOWN command: every registered subcommand consumes its own
    // leading arg via its own action, so anything still in `cmd.args` didn't
    // match. Reject it exit 3 (NOT_FOUND) per the S9 contract instead of
    // silently routing the typo through home (which would exit 0).
    const leftovers = cmd.args;
    if (leftovers.length > 0) {
      fail(
        EXIT.NOT_FOUND,
        `unknown command '${leftovers[0]}' (no such subcommand). Run \`noir --help\` for the list.`,
        toCliOptions(cmd.optsWithGlobals()),
      );
    }
    await home(toCliOptions(actionGlobals(args)), homeDeps);
  });

  return program;
}

/** Singleton program used by the bin entry (`run`) and re-exported for convenience. */
export const program: Command = createProgram();

// ---------------------------------------------------------------------------
// Error → exit-code mapping lives in `./output.js` (`handleError`); it never
// throws and never calls `process.exit` (commander's `exitOverride` already
// prevented that for commander's own errors).
// ---------------------------------------------------------------------------

/**
 * Parse `argv` (user-form: NO node/script prefix) on the singleton program and
 * return the resulting exit code. Sets `process.exitCode` for the real bin;
 * tests can either call this or drive `createProgram().parseAsync` directly.
 */
export async function run(argv: readonly string[] = []): Promise<number> {
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    handleError(err);
  }
  return typeof process.exitCode === 'number' ? process.exitCode : EXIT.OK;
}

// Auto-invoke only when bin.ts is the entry point (real `noir` bin, or a tsx
// subprocess as in gate1-stdio). When vitest imports bin.js as a module,
// process.argv[1] is the runner, so this is skipped and the program stays idle.
const isMainModule = (() => {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry.length === 0) return false;
    // Resolve symlinks: a global npm install invokes the bin via a symlink
    // (.../bin/noir -> .../lib/node_modules/@noir-ai/cli/dist/bin.js), so argv[1]
    // is the symlink path while import.meta.url is the RESOLVED real path. Compare
    // the REAL paths so `noir` runs under BOTH direct + symlinked invocation.
    // (Without this, a global `noir` install silently exits 0 — main() never runs.)
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  void run(process.argv.slice(2));
}
