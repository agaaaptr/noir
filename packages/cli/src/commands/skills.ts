// S9 — `noir skills {list,sync}`.
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
import {
  type BuiltinSkill,
  buildRegistry,
  discoverAll,
  emitSkillsToDir,
  type IntegrationSkill,
  lintSkill,
} from '@noir-ai/skills';
import { type CliOptions, EXIT, fail, info, log, table, warn } from '../output.js';

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
  'noir-brainstorming': 'discovery',
  'noir-sync': 'discovery',
  'noir-checkpoint': 'discovery',
  'noir-exploring': 'discovery',
  'noir-spec': 'spec',
  'noir-planning': 'plan',
  'noir-prd': 'plan',
  'noir-executing-plans': 'execute',
  'noir-test-driven-development': 'execute',
  'noir-systematic-debugging': 'execute',
  'noir-subagent': 'execute',
  'noir-parallel': 'execute',
  'noir-verifying': 'verify',
  'noir-security': 'verify',
  'noir-wrap': 'document',
  'noir-readme': 'document',
  'noir-shipping': 'git',
  'noir-worktree': 'git',
  'noir-recall': 'memory',
  'noir-remember': 'memory',
  'noir-context': 'context',
  'noir-frontend': 'domain',
  'noir-backend': 'domain',
  'noir-doctor': 'meta',
  'noir-writing-skills': 'meta',
  'noir-rules': 'meta',
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
  /** Slice X — distinguishes the shipped builtins from the integration skills
   *  (e.g. `noir-clickup`) so `noir skills list` shows the full pack and which
   *  entries are integrations. Defaults to `'builtin'` for back-compat. */
  kind: 'builtin' | 'integration';
  /** C3 — `full` (playbook) vs `stub` (marker). Derived from the body; the
   *  registry enriches this from the same source so list + registry agree. */
  status: 'full' | 'stub';
}

function toRow(s: BuiltinSkill, kind: 'builtin' | 'integration' = 'builtin'): SkillRow {
  const description =
    typeof s.frontmatter.description === 'string' ? s.frontmatter.description : '';
  const status: 'full' | 'stub' = s.skillMd.includes('> **Stub:**') ? 'stub' : 'full';
  return { name: s.name, category: categoryOf(s.name), description, kind, status };
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
 * `noir skills list`: discover the full shipped pack (builtins + integrations)
 * and render it. Consistent with `emitSkillsToDir` (which emits BOTH) — the
 * `noir-clickup` integration shows up here alongside the 33 builtins.
 *
 * `--json` emits `{ok:true, data:{count, skills: SkillRow[]}}` to stdout. A
 * discovery failure (the pack dir is unreadable) maps to exit 1 (ERROR) —
 * not exit 4, since this command never touches the daemon.
 */
export async function skillsList(opts: SkillsOptions): Promise<void> {
  let builtins: BuiltinSkill[];
  let integrations: IntegrationSkill[];
  try {
    const all = discoverAll();
    builtins = all.builtins;
    integrations = all.integrations;
  } catch (err) {
    fail(
      EXIT.ERROR,
      `skills list: could not discover skills (${err instanceof Error ? err.message : String(err)})`,
      opts,
    );
  }
  const rows = [
    ...builtins.map((b) => toRow(b, 'builtin')),
    ...integrations.map((i) => toRow(i, 'integration')),
  ];
  // Status is derived from the body (stub marker); category uses the CLI's
  // CATEGORY map (name-derived) until skills carry `metadata.category` — after
  // the C3 content rewrite every skill does, and `skills registry` reads it.
  // `skills list` keeps the curated CATEGORY map as its single source so the
  // human table is stable; the registry is the queryable form.
  const data = { count: rows.length, skills: rows };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }

  const intCount = integrations.length;
  const banner =
    intCount > 0
      ? `noir skills — ${rows.length} skill${rows.length === 1 ? '' : 's'} (${builtins.length} builtin, ${intCount} integration${intCount === 1 ? '' : 's'})`
      : `noir skills — ${rows.length} builtin skill${rows.length === 1 ? '' : 's'}`;
  log(banner, opts);
  table(
    rows.map((r) => ({
      Skill: r.name,
      Kind: r.kind,
      Category: r.category,
      Status: r.status,
      Description: truncate(r.description, 80),
    })),
    ['Skill', 'Kind', 'Category', 'Status', 'Description'],
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
  const pruned = summary.pruned ?? [];
  const data = {
    emitted: summary.emitted,
    references: summary.references,
    dir,
    pruned,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }

  log(
    `Synced ${summary.emitted.length} Noir skill${summary.emitted.length === 1 ? '' : 's'} to ${dir}.`,
    opts,
  );
  // Surface stale-dir pruning in both human + JSON modes for parity with
  // `noir sync` (the structured `pruned` field above covers --json).
  if (pruned.length > 0) {
    warn(
      `Pruned ${pruned.length} stale noir-* skill dir${pruned.length === 1 ? '' : 's'}: ${pruned.join(', ')}`,
      opts,
    );
  }
}

// ---------------------------------------------------------------------------
// `noir skills lint`
// ---------------------------------------------------------------------------
/**
 * `noir skills lint`: the C3 structural quality gate over the full shipped pack.
 * Runs `lintSkill` (validateSkill errors + soft warnings) over `discoverAll()`.
 * In-process (no daemon) — the pack is a filesystem artifact.
 *
 * Exit contract: 0 when every skill validates clean (errors empty); 1 when any
 * skill has errors (the gate fails). Warnings alone do NOT fail the lint — they
 * are advisory and listed for the author. This mirrors how a real linter treats
 * hard errors vs style warnings.
 *
 * `--json` emits `{ok, data:{skills:[{name, errors, warnings}]}}` to stdout
 * (the only stdout write); the human report goes to stderr.
 */
export async function skillsLint(opts: SkillsOptions): Promise<void> {
  let skills: Array<{ name: string; errors: string[]; warnings: string[] }>;
  try {
    const all = discoverAll();
    skills = [...all.builtins, ...all.integrations].map(lintSkill);
  } catch (err) {
    fail(
      EXIT.ERROR,
      `skills lint: could not lint skills (${err instanceof Error ? err.message : String(err)})`,
      opts,
    );
  }
  const errored = skills.filter((s) => s.errors.length > 0);
  const warned = skills.filter((s) => s.warnings.length > 0 && s.errors.length === 0);

  const data = { count: skills.length, errored: errored.length, skills };
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: errored.length === 0, data })}\n`);
    return;
  }

  if (errored.length === 0) {
    log(`noir skills lint — ${skills.length} skills, all validate clean.`, opts);
  } else {
    warn(
      `noir skills lint — ${errored.length} skill${errored.length === 1 ? '' : 's'} FAIL validation:`,
      opts,
    );
  }
  for (const s of errored) {
    for (const e of s.errors) warn(`  ${s.name}: ${e}`, opts);
  }
  if (warned.length > 0) {
    info(`  ${warned.length} skill${warned.length === 1 ? '' : 's'} carry lint warnings:`, opts);
    for (const s of warned) {
      for (const w of s.warnings) info(`  ${s.name}: ${w}`, opts);
    }
  }
}

// ---------------------------------------------------------------------------
// `noir skills registry`
// ---------------------------------------------------------------------------
/**
 * `noir skills registry`: emit the C3 runtime-derived skill registry (id, kind,
 * category, version, status, refs, lines). In-process (no daemon) — reads the
 * shipped pack via `buildRegistry()`. The registry is NOT a committed file;
 * frontmatter is the single source of truth and this command derives it on
 * demand (C3 decision D3).
 *
 * `--json` emits `{ok:true, data:{count, skills: SkillRegistryEntry[]}}` to
 * stdout; the human view is a table to stderr.
 */
export async function skillsRegistry(opts: SkillsOptions): Promise<void> {
  let reg: ReturnType<typeof buildRegistry>;
  try {
    reg = buildRegistry();
  } catch (err) {
    fail(
      EXIT.ERROR,
      `skills registry: could not build registry (${err instanceof Error ? err.message : String(err)})`,
      opts,
    );
  }
  const data = { count: reg.length, skills: reg };
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  log(`noir skills registry — ${reg.length} skills.`, opts);
  table(
    reg.map((r) => ({
      Skill: r.name,
      Kind: r.kind,
      Category: r.category,
      Version: r.version,
      Status: r.status,
      Refs: String(r.referenceCount),
      Lines: String(r.lines),
    })),
    ['Skill', 'Kind', 'Category', 'Version', 'Status', 'Refs', 'Lines'],
    opts,
  );
}
