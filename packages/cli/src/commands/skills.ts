// S9 t6 — `noir skills {list,sync}`.
//
// Both sub-commands are IN-PROCESS (no daemon, no store): the builtin skill
// pack is a filesystem artifact shipped with `@noir-ai/skills`, so `list` reads
// it directly via `discoverBuiltin()` and `sync` re-emits it into the host
// adapter's skills dir via `emitSkillsToDir` (the same primitive `noir init` /
// `noir sync` use). Skill state is host-local files, never the daemon store, so
// these never hit exit 4 (DAEMON_DOWN).
//
// Scriptability (S9 hard rule): `--json` emits the versioned `{ok,data}`
// envelope to stdout (the only stdout write); the human table + banner go to
// stderr via the centralized `table()` / `log()` helpers, which auto-strip
// under NO_COLOR / non-TTY / --json. No interactive input is ever required, so
// these commands are safe on a pipe / CI unconditionally.

import { claudeAdapter } from '@noir-ai/adapters';
import { loadProjectInfo } from '@noir-ai/core';
import { type BuiltinSkill, discoverBuiltin, emitSkillsToDir } from '@noir-ai/skills';
import { type CliOptions, EXIT, fail, info, log, table } from '../output.js';

/** Options accepted by `skills` sub-commands (the global flags only). */
export interface SkillsOptions extends CliOptions {}

// ---------------------------------------------------------------------------
// Category derivation.
//
// Skills ship no `category` frontmatter field (S5 contract is `{name,
// description, references?}`), so the column is a PRESENTATION-layer grouping
// derived from the skill name. The map covers the 31 builtins; an unknown name
// falls back to its `noir-`-stripped segment so a newly authored skill still
// gets a sensible cell instead of an empty one. This is display-only — the
// `--json` payload carries `category` too (same derivation) for consistency.
// ---------------------------------------------------------------------------
const CATEGORY: Record<string, string> = {
  'noir-brainstorm': 'discovery',
  'noir-intake': 'discovery',
  'noir-clarify': 'discovery',
  'noir-explore': 'discovery',
  'noir-spec': 'spec',
  'noir-plan': 'plan',
  'noir-execute': 'execute',
  'noir-tdd': 'execute',
  'noir-debug': 'execute',
  'noir-subagent': 'execute',
  'noir-parallel': 'execute',
  'noir-verify': 'verify',
  'noir-review': 'verify',
  'noir-security': 'verify',
  'noir-test': 'verify',
  'noir-document': 'document',
  'noir-readme': 'document',
  'noir-commit': 'git',
  'noir-branch': 'git',
  'noir-pr': 'git',
  'noir-worktree': 'git',
  'noir-recall': 'memory',
  'noir-remember': 'memory',
  'noir-checkpoint': 'memory',
  'noir-context': 'context',
  'noir-frontend': 'domain',
  'noir-backend': 'domain',
  'noir-doctor': 'meta',
  'noir-skill-author': 'meta',
  'noir-sync': 'meta',
  'noir-wrap': 'meta',
};

function categoryOf(name: string): string {
  const mapped = CATEGORY[name];
  if (mapped !== undefined) return mapped;
  // Unknown skill: its own topic (the `noir-`-stripped name) is a reasonable
  // default cell so the table never shows an empty category.
  return name.replace(/^noir-/, '') || 'general';
}

/** Normalized skill row (the `data.skills[]` element + the table source). */
export interface SkillRow {
  name: string;
  category: string;
  description: string;
}

function toRow(s: BuiltinSkill): SkillRow {
  const description =
    typeof s.frontmatter.description === 'string' ? s.frontmatter.description : '';
  return { name: s.name, category: categoryOf(s.name), description };
}

/**
 * Truncate `text` to `max` chars on a word boundary for dense table cells. This
 * is DISPLAY-ONLY for the human table; the full description is always carried
 * verbatim in the `--json` payload. (Distinct from the S6 "never truncate the
 * retrieval DATA" rule — that governs search snippets, not table formatting.)
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, Math.max(0, max - 1));
  // Cut at the last whitespace inside the slice so we don't split a word.
  const boundary = slice.lastIndexOf(' ');
  const head = boundary > 0 ? slice.slice(0, boundary) : slice;
  return `${head.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// `noir skills list`
// ---------------------------------------------------------------------------
/**
 * `noir skills list`: discover the builtin pack and render it.
 *
 * `--json` emits `{ok:true, data:{count, skills: SkillRow[]}}` to stdout. A
 * discovery failure (the builtin dir is unreadable) maps to exit 1 (ERROR) —
 * not exit 4, since this command never touches the daemon.
 */
export async function skillsList(opts: SkillsOptions): Promise<void> {
  let builtins: BuiltinSkill[];
  try {
    builtins = discoverBuiltin();
  } catch (err) {
    fail(
      EXIT.ERROR,
      `skills list: could not discover builtin skills (${err instanceof Error ? err.message : String(err)})`,
      opts,
    );
  }
  const rows = builtins.map(toRow);
  const data = { count: rows.length, skills: rows };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }

  log(`noir skills — ${rows.length} builtin skill${rows.length === 1 ? '' : 's'}`, opts);
  table(
    rows.map((r) => ({
      Skill: r.name,
      Category: r.category,
      Description: truncate(r.description, 80),
    })),
    ['Skill', 'Category', 'Description'],
    opts,
  );
}

// ---------------------------------------------------------------------------
// `noir skills sync`
// ---------------------------------------------------------------------------
/**
 * `noir skills sync`: re-emit the builtin pack into the host adapter's skills
 * dir. Reuses the same `emitSkillsToDir` primitive as `noir init` / `noir sync`
 * (the host-local file write; no daemon involved).
 *
 * Requires the project to be initialized (`loadProjectInfo` throws otherwise →
 * exit 1 with the "Run `noir init` first" hint). When the host adapter exposes
 * no `skillsDir` (no skill emitter for this host), the command reports nothing
 * to sync and exits 0 — behavior-preserving with the existing `noir sync`.
 *
 * `--json` emits `{ok:true, data:{emitted, references, dir}}` to stdout.
 */
export async function skillsSync(opts: SkillsOptions): Promise<void> {
  const root = process.cwd();
  // loadProjectInfo asserts Noir is initialized; its throw propagates as a
  // plain Error → exit 1 with the actionable hint (not a daemon-down).
  const project = loadProjectInfo(root);

  if (!claudeAdapter.skillsDir) {
    const data = {
      emitted: [],
      references: 0,
      host: project.config.host,
      reason: 'no-skill-emitter',
    };
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
      return;
    }
    info('This host has no skill emitter; nothing to sync.', opts);
    return;
  }

  const dir = claudeAdapter.skillsDir({ root });
  const summary = await emitSkillsToDir(dir);
  const data = {
    emitted: summary.emitted,
    references: summary.references,
    dir,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }

  log(
    `Synced ${summary.emitted.length} Noir skill${summary.emitted.length === 1 ? '' : 's'} to ${dir}.`,
    opts,
  );
}
