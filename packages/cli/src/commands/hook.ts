import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `noir hook` — the host-invoked SessionStart / SubagentStart hook runner.
 *
 * Claude Code runs the command the scaffold writes into
 * `.claude/settings.local.json` (`"<noir shim>" hook`) and pipes a JSON object
 * to stdin describing the event (`hook_event_name`, `cwd`, `session_id`, …).
 * This command reads that, reads the two always-on Noir files the project owns
 * (`.noir/router.md` + `.noir/rules/anti-slop.md`), and emits the single-line
 * JSON envelope Claude Code expects: `hookSpecificOutput.hookEventName` (the
 * event echoed back) plus `additionalContext` when there is content to inject.
 *
 * Why a CLI command and not the old `.noir/hooks/noir-session-start.mjs` runner:
 * the shim resolves the managed Node with an absolute path and is kept
 * executable by `ensureShimExecutable()`, so the hook neither depends on `node`
 * being on PATH (a GUI-launched client has none) nor on the exec bit of a
 * gitignored file. A hook must never fail the session: every read is
 * best-effort and the command always exits 0 with valid JSON (or empty output),
 * never an error.
 */
export function hook(): void {
  let eventName = 'SessionStart';
  let root = process.cwd();
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>;
    if (typeof input.hook_event_name === 'string' && input.hook_event_name !== '') {
      eventName = input.hook_event_name;
    }
    if (typeof input.cwd === 'string' && input.cwd !== '') root = input.cwd;
  } catch {
    // No stdin or not JSON — Claude Code always sends it, but never crash here.
  }

  // Compact single-line JSON: the parser reads output line-by-line and a
  // pretty-printed envelope would be silently dropped.
  process.stdout.write(JSON.stringify(hookOutput(eventName, root)));
}

/** Build the exact `hookSpecificOutput` envelope for an event. Exported so the
 *  schema contract is testable without a host process. Walks up from `root` to
 *  the project that owns `.noir/`, so a session started in a subdirectory still
 *  finds the router + ruleset; bounded by the filesystem root. */
export function hookOutput(eventName: string, root: string): Record<string, unknown> {
  let routerPath: string | null = null;
  let rulesPath: string | null = null;
  for (let dir = root; ; dir = join(dir, '..')) {
    const router = join(dir, '.noir', 'router.md');
    const rules = join(dir, '.noir', 'rules', 'anti-slop.md');
    if (existsSync(router) || existsSync(rules)) {
      routerPath = router;
      rulesPath = rules;
      break;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
  }

  const parts: string[] = [];
  for (const path of [routerPath, rulesPath]) {
    if (path === null) continue;
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text !== '') parts.push(text);
    } catch {
      // Unreadable — contribute nothing rather than fail the session.
    }
  }

  return parts.length === 0
    ? { hookSpecificOutput: { hookEventName: eventName } }
    : { hookSpecificOutput: { hookEventName: eventName, additionalContext: parts.join('\n\n') } };
}
