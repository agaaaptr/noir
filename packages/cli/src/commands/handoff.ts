// `noir handoff` (alias `noir wrap`).
//
// The on-demand, pasteable HOST HANDOFF artifact that closes Noir's internal
// loop and points the user at the right host CLI. Reuses the SAME aggregation
// path as `noir status` (`gatherStatusPayload`) and the SAME phase→skill map as
// `noir task` (`PHASE_SKILL` / `skillFor`), then does a BOUNDED in-process
// `context_search` + `memory_recall` for the active task's domain to seed the
// host prompt, and renders a structured MARKDOWN block to STDOUT for pasteability.
//
// DOCTRINE (hard constraint): Noir NEVER launches the host and NEVER writes the
// artifact into CLAUDE.md/AGENTS.md (claude byte-parity risk + the double-`@`-
// import hazard the manifest already fixed). The host-launch directive is TEXT
// ONLY — `hostLaunchDirective(host)` / `HostAdapter.emitHandoff` produce the
// "Open `<host>` …" wording; `noir handoff` never spawns anything.
//
// Graceful degradation (mirrors `status.ts`): a down daemon is reported with an
// honest note ("start `noir daemon start` for live task/memory") and the
// artifact still renders from in-process `.noir/` reads (project info + a
// workflow snapshot if locally available) — exit 0. A missing embedder during
// the bounded extraction folds to `null` (via `tryTool`); the seed section
// renders a "degraded" note instead of failing.
//
// Stream discipline: the markdown artifact → STDOUT ONLY (the single
// stdout write under the default path); `--json` emits the structured payload
// via the versioned `{ok,data}` envelope instead; ALL diagnostics (the
// "wrote <path>" confirmation, the daemon-down note) → STDERR via `info()`.
// `--write` persists to `.noir/handoff/<id>.md` (gitignored — see
// `@noir-ai/core` `syncIgnores`); the path is reported on stderr, never stdout.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultHandoffBlock,
  type EmitContext,
  type HandoffPayload,
  type HostId,
  hostLaunchDirective,
  resolveAdapter,
} from '@noir-ai/adapters';
import { loadProjectInfo, NOIR_DIR } from '@noir-ai/core';
import {
  type DaemonClientOptions,
  type DaemonProbe,
  probeDaemon,
  withRunningDaemon,
} from '../daemon-client.js';
import { type CliOptions, info } from '../output.js';
import { gatherStatusPayload, tryTool } from './status.js';
import { PHASE_SKILL, skillFor } from './task.js';

/** Options accepted by `noir handoff` (globals + daemon-client knobs). */
export interface HandoffOptions extends CliOptions, DaemonClientOptions {
  /** `--write`: persist the artifact to `.noir/handoff/<id>.md` (gitignored). */
  write?: boolean;
}

/** Bounded extraction limits — small enough to seed a prompt, never a dump. */
const SEED_LIMIT = 5;

// ---------------------------------------------------------------------------
// Wire result shapes (slices of the daemon payloads; local types — the CLI
// depends only on the MCP wire contract, mirrors status.ts / context.ts).
// ---------------------------------------------------------------------------
interface ContextSearchHit {
  path?: string;
  score?: number;
  snippet?: string;
  source?: string;
}
interface ContextSearchResult {
  ok?: boolean;
  results?: unknown;
  consumedTokens?: number;
  truncated?: boolean;
  degraded?: boolean;
  mode?: string;
}
interface MemoryRecallHit {
  id?: string;
  observation?: Record<string, unknown>;
  score?: number;
}
interface MemoryRecallResult {
  ok?: boolean;
  results?: unknown;
  degraded?: boolean;
}

/** A normalized context_search seed entry rendered in the artifact. */
export interface HandoffContextHit {
  path: string;
  score: number;
  snippet: string;
}
/** A normalized memory_recall seed entry rendered in the artifact. */
export interface HandoffMemoryHit {
  id: string;
  summary: string;
}

/** The structured payload emitted by `--json` (and the source for the markdown
 *  render). Every nullable field degrades cleanly (daemon-down / no active task
 *  / missing embedder → null + a note), so the artifact NEVER hard-fails. */
export interface HandoffPayloadFull {
  project: { id: string; name: string };
  host: HostId;
  /** Host-launch directive text (single source: `hostLaunchDirective` or the
   *  adapter's `emitHandoff` override). TEXT ONLY — never a spawn. */
  directive: string;
  task: {
    taskId: string;
    phase: string;
    nextGate: string | null;
    nextSkill: string | null;
  } | null;
  /** Bounded context_search seed (top hits for the task domain). Null when the
   *  daemon is down OR the embedder is missing (degraded note rendered). */
  contextSeed: HandoffContextHit[] | null;
  /** Bounded memory_recall seed. Null when the daemon is down. */
  memorySeed: HandoffMemoryHit[] | null;
  /** Honest degradation flags so a `--json` consumer can branch. */
  degraded: {
    daemonDown: boolean;
    embedderMissing: boolean;
  };
}

// ---------------------------------------------------------------------------
// Rendering — the markdown artifact (STDOUT) + the structured payload (--json).
// ---------------------------------------------------------------------------

/** Heading line: `# Noir handoff — <name> (<id>)`. */
function heading(name: string, id: string): string {
  return `# Noir handoff — ${name} (${id})`;
}

/** Render the markdown artifact from the structured payload. STDOUT-safe (no
 *  ANSI — the artifact is pasteable text; `--no-color` honored by virtue of
 *  never coloring). */
function renderMarkdown(p: HandoffPayloadFull): string {
  const lines: string[] = [];
  lines.push(heading(p.project.name, p.project.id));
  lines.push('');

  // Phase / gate line.
  if (p.task) {
    const gate = p.task.nextGate ?? '—';
    lines.push(`**Phase:** ${p.task.phase} — next gate: ${gate}`);
  } else {
    lines.push('**Phase:** no active task');
  }

  // Host directive (the pasteable "open your host" line).
  lines.push('');
  lines.push('## Open host');
  lines.push(p.directive);

  // Next step.
  lines.push('');
  lines.push('## Next step');
  if (p.task?.nextSkill) {
    lines.push(`Run \`${p.task.nextSkill}\` — the host's next gate skill.`);
  } else {
    lines.push('No further gate ahead (past verify, or no active task).');
  }

  // Extracted context seed.
  lines.push('');
  lines.push('## Extracted context (seed)');
  if (p.contextSeed && p.contextSeed.length > 0) {
    for (const h of p.contextSeed) {
      lines.push(`- \`${h.path}\` (score ${h.score.toFixed(4)})`);
      const snip = h.snippet.trim();
      if (snip.length > 0) lines.push(`  > ${snip.replace(/\n/g, '\n  > ')}`);
    }
  } else if (p.degraded.embedderMissing) {
    lines.push(
      '_Embedder unavailable — degraded to BM25-only or no hits. Start `noir daemon start` for live context._',
    );
  } else {
    lines.push('_No context hits (or daemon down). Start `noir daemon start` for live context._');
  }

  // Extracted memory seed.
  lines.push('');
  lines.push('## Extracted memory (seed)');
  if (p.memorySeed && p.memorySeed.length > 0) {
    for (const m of p.memorySeed) {
      lines.push(`- \`${m.id}\` — ${m.summary}`);
    }
  } else {
    lines.push(
      '_No memory observations (or daemon down). Start `noir daemon start` for live memory._',
    );
  }

  // Live data pointer.
  lines.push('');
  lines.push('## Live data — call these from the host (already wired via the host MCP config)');
  lines.push('- `noir.workflow_status` · `noir.context_search` · `noir.memory_recall`');

  // Daemon-down note (honest degradation, mirrors status.ts).
  if (p.degraded.daemonDown) {
    lines.push('');
    lines.push('> **Note:** daemon not running — start `noir daemon start` for live task/memory.');
  }

  lines.push('');
  return lines.join('\n');
}

/** Normalize a raw context_search hit into the render shape. */
function toContextHit(raw: unknown): HandoffContextHit {
  const h = (raw ?? {}) as ContextSearchHit;
  return {
    path: typeof h.path === 'string' ? h.path : '<unknown>',
    score: typeof h.score === 'number' ? h.score : 0,
    snippet: typeof h.snippet === 'string' ? h.snippet : '',
  };
}

/** Coerce a memory_recall observation's display summary from a raw hit. */
function observationSummary(raw: MemoryRecallHit): string {
  const obs = raw.observation;
  if (obs && typeof obs === 'object') {
    const content = obs.content;
    if (typeof content === 'string' && content.length > 0) {
      return content.length > 160 ? `${content.slice(0, 157)}…` : content;
    }
    const type = obs.type;
    if (typeof type === 'string') return `(${type})`;
  }
  return '';
}

/** Normalize a raw memory_recall hit into the render shape. */
function toMemoryHit(raw: unknown): HandoffMemoryHit {
  const h = (raw ?? {}) as MemoryRecallHit;
  return {
    id: typeof h.id === 'string' ? h.id : '<unknown>',
    summary: observationSummary(h),
  };
}

/** Build the host-facing {@link HandoffPayload} (the adapter hook's input) from
 *  the full snapshot. Narrowed so the adapter never sees CLI-internal fields. */
function toHostPayload(p: HandoffPayloadFull): HandoffPayload {
  return {
    project: p.project,
    host: p.host,
    task: p.task,
  };
}

/** Resolve the directive text: the adapter's `emitHandoff` override if present,
 *  else the shared `defaultHandoffBlock` (which composes `hostLaunchDirective`).
 *  Routes via `resolveAdapter` (no CLI branching — adding a host needs no CLI
 *  edit, mirroring the host-adapter seam). */
function resolveDirective(root: string, p: HandoffPayloadFull): string {
  const ctx: EmitContext = { root };
  const adapter = resolveAdapter(p.host);
  const hostPayload = toHostPayload(p);
  if (typeof adapter.emitHandoff === 'function') {
    return adapter.emitHandoff(ctx, hostPayload);
  }
  return defaultHandoffBlock(ctx, hostPayload);
}

/** Derive the on-disk filename for `--write`: `.noir/handoff/<id>.md`. The id is
 *  the active task id when available, else the project id (stable + unique per
 *  project). The path is gitignored via `syncIgnores`. */
function handoffFilePath(root: string, taskId: string | undefined, projectId: string): string {
  const id = typeof taskId === 'string' && taskId.length > 0 ? taskId : projectId;
  return join(root, NOIR_DIR, 'handoff', `${id}.md`);
}

// ---------------------------------------------------------------------------
// Bounded extraction — `context_search` + `memory_recall` for the active task's
// domain. Uses `withRunningDaemon` (probe-only — NEVER starts a daemon) so a
// down daemon degrades to `null` (exit 0) instead of exit 4. A missing embedder
// throws inside the tool call → `tryTool` folds to `null` → "degraded" note.
// ---------------------------------------------------------------------------

/** Run the bounded extraction over one daemon connection (if the daemon is up).
 *  Returns `{context, memory}` where each is `null` on any failure path. The
 *  `query` is the active task id (the task's domain); when no task is active,
 *  the project name is used as a stable fallback. */
async function extractSeeds(
  opts: HandoffOptions,
  probe: DaemonProbe,
  query: string,
): Promise<{ context: HandoffContextHit[] | null; memory: HandoffMemoryHit[] | null }> {
  // Guard: if the probe already said down, skip the connection entirely (the
  // artifact renders with a "start daemon" note — exit 0).
  if (!probe.running) return { context: null, memory: null };

  let context: HandoffContextHit[] | null = null;
  let memory: HandoffMemoryHit[] | null = null;

  await withRunningDaemon(
    opts,
    async (caller): Promise<void> => {
      // BOUNDED: small `limit` + a bounded `query` (the task id / project name)
      // on both tools — a seed, never a dump. tryTool folds ANY failure (missing
      // engine, embedder throw, transport hiccup) to null so the artifact never
      // hard-fails on extraction.
      const ctxRes = await tryTool<ContextSearchResult>(caller, 'context_search', {
        query,
        limit: SEED_LIMIT,
      });
      if (ctxRes && ctxRes.ok !== false && Array.isArray(ctxRes.results)) {
        context = (ctxRes.results as unknown[])
          .slice(0, SEED_LIMIT)
          .map(toContextHit)
          .filter((h) => h.path !== '<unknown>' || h.snippet.length > 0);
      }
      const memRes = await tryTool<MemoryRecallResult>(caller, 'memory_recall', {
        query,
        limit: SEED_LIMIT,
      });
      if (memRes && memRes.ok !== false && Array.isArray(memRes.results)) {
        memory = (memRes.results as unknown[])
          .slice(0, SEED_LIMIT)
          .map(toMemoryHit)
          .filter((h) => h.summary.length > 0);
      }
    },
    probe,
  );

  return { context, memory };
}

/** Probe helper — re-probe (gatherStatusPayload already probed once, but we need
 *  the probe object here for the bounded extraction). Mirrors status.ts: never
 *  starts a daemon, returns `{running:false}` on any miss. Static import matches
 *  status.ts — vi.mock hoisting makes the mock apply to static imports too, so a
 *  dynamic import is unnecessary (and it would trigger tsup code-splitting, which
 *  re-chunks the CLI bin entry and breaks its `isMainModule` guard). */
async function probeOnly(opts: HandoffOptions): Promise<DaemonProbe> {
  return probeDaemon(opts);
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

/**
 * `noir handoff` (alias `noir wrap`): gather the live snapshot + a bounded
 * context/memory seed and render a pasteable host-handoff artifact.
 *
 * - Default: markdown → STDOUT (the single stdout write).
 * - `--write`: persist to `.noir/handoff/<id>.md` (gitignored); confirm on stderr.
 * - `--json`: emit the structured `{ok:true, data: HandoffPayloadFull}` envelope.
 *
 * Never hard-fails on a down daemon or a missing embedder — degrades to a note
 * (mirrors `status.ts`). Uninitialized project → exit 1 from `loadProjectInfo`.
 */
export async function handoff(opts: HandoffOptions): Promise<void> {
  // In-process project info — no daemon round-trip. Uninitialized → exit 1
  // (same as status / every other command).
  const project = loadProjectInfo(process.cwd());
  const host = project.config.host;

  // Snapshot — the SAME path `noir status` uses (single source). gatherStatusPayload
  // probes + folds every optional engine to null. We re-probe here for the extraction
  // step (the probe is cheap — one GET /health).
  const snapshot = await gatherStatusPayload(opts);
  const probe = await probeOnly(opts);

  // Active task + next-skill (reuse task.ts's PHASE_SKILL — single source).
  const task = snapshot.workflow
    ? {
        taskId: snapshot.workflow.taskId,
        phase: snapshot.workflow.phase,
        nextGate: snapshot.workflow.nextGate,
        nextSkill: skillFor(snapshot.workflow.nextGate) ?? skillFor(snapshot.workflow.phase),
      }
    : null;

  // Bounded extraction — the query is the task id (the task's domain), else the
  // project name as a stable fallback.
  const query = task?.taskId ?? project.name;
  const { context, memory } = await extractSeeds(opts, probe, query);

  const full: HandoffPayloadFull = {
    project: { id: project.id, name: project.name },
    host,
    directive: '', // filled after the host payload is assembled (below)
    task,
    contextSeed: context,
    memorySeed: memory,
    degraded: {
      daemonDown: !probe.running,
      embedderMissing: context === null && probe.running,
    },
  };
  full.directive = resolveDirective(project.root, full);

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: full })}\n`);
    return;
  }

  const md = renderMarkdown(full);

  if (opts.write === true) {
    const path = handoffFilePath(project.root, task?.taskId, project.id);
    mkdirSync(join(project.root, NOIR_DIR, 'handoff'), { recursive: true });
    writeFileSync(path, md, 'utf8');
    // Diagnostic → STDERR (stream discipline: stdout is reserved for the
    // artifact under the default path; --write is a convenience that reports
    // its path here, never on stdout).
    info(`handoff written to ${path}`, opts);
    return;
  }

  // Default: markdown → STDOUT ONLY (pasteability — the user pipes this into a
  // file or straight into the host). No trailing diagnostics on stdout.
  process.stdout.write(md);
}

// Re-export so bin.ts can wire `noir wrap` as a sibling alias dispatching the
// same handler, and so PHASE_SKILL stays usable from the test surface.
export { hostLaunchDirective, PHASE_SKILL };
