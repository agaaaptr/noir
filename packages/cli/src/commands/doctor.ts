// S9 — `noir doctor`.
//
// Environment + project health. Runs a fixed set of checks and renders a
// results table (human, stderr) or the versioned `{ok,data}` envelope (--json,
// stdout). Exit 1 if any CRITICAL (fail) check is unhealthy, else 0.
//
// Severity model (S9 spec F8):
//   - ok   — healthy.
//   - warn — degraded but usable (daemon down, onnx missing, provider key
//            missing, project not initialized). NEVER triggers exit 1.
//   - fail — CRITICAL: the product is broken on this host. Only `config` (parse
//            error), `native deps` (better-sqlite3 / sqlite-vec will not load),
//            and `store` (open fails) can fail. Exit 1 if any fail.
//
// Honesty rules: provider status uses `resolveModelConfig` — a PURE projection
// of the user's config + env-var NAME presence; it makes NO live call (blueprint
// D5). Native-dep probes are best-effort try/catch (the store's native
// binaries are probed via `vecAvailability`, the single cross-package surface;
// onnxruntime-node is the context engine's own dep and is probed separately).
//
// Cold-start (NF6): the @noir-ai/store import (which loads better-sqlite3) is
// DYNAMIC, inside the action, so merely running `noir status` / `noir --help`
// never pays the native-bindings cost. @noir-ai/model is imported eagerly — its
// provider self-registration is light (SDKs load lazily inside `complete()`).
//
// Stream discipline (S9): `--json` writes `{ok:true, data:{checks,summary}}`
// to stdout (the only stdout write). Doctor always emits `ok:true` because the
// COMMAND succeeded in producing a diagnosis; the system-health pass/fail is
// signaled by the EXIT CODE (0 healthy / 1 critical failure) — the same shape
// `npm audit --json` uses (valid JSON out, non-zero exit when issues found).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import {
  detectActiveMethod,
  type InstallMethod,
  latestVersionFromCache,
  loadProjectInfo,
  NOIR_VERSION,
  type ProjectInfo,
  paths,
  readInstallRecord,
  readUpdateCache,
} from '@noir-ai/core';
import { CURRENT_SCAFFOLD_VERSION, readScaffoldVersion } from '@noir-ai/create';
import { pidAlive, readDaemonRecord } from '@noir-ai/daemon';
import { resolveModelConfig } from '@noir-ai/model';
import {
  type CliOptions,
  EXIT,
  error as err,
  log,
  NoirCliError,
  success,
  table,
  warn,
} from '../output.js';
import { type BadgeState, badge } from '../theme.js';

/** Options accepted by `doctor`: the global flags + the opt-in `--dedup`. */
export interface DoctorOptions extends CliOptions {
  /** `--dedup`: scan host-context + `.noir/` docs for semantic near-duplicates.
   *  Opt-in (loads the local embedder) so a default `noir doctor` stays fast. */
  dedup?: boolean;
}

type Severity = 'ok' | 'warn' | 'fail';

/** One row of the doctor report (table cell + `--json` element). */
export interface CheckResult {
  name: string;
  status: Severity;
  detail: string;
}

/** The `data` payload of `noir doctor --json`. */
export interface DoctorPayload {
  noir: string;
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number };
  /** Scaffold-version drift (slice S). `onDisk` is null when the stamp is
   *  absent (uninitialized or pre-Slice-S project); `drift` is true only when
   *  a stamp is present AND differs from the engine's current version. */
  scaffold: { onDisk: string | null; current: string; drift: boolean };
  /** RULES.md budget measurement. `null` when the project isn't
   *  initialized OR `.noir/rules/RULES.md` is absent — in either case there
   *  is nothing to measure and the check row stays informational (warn skip
   *  or ok "no RULES.md"). Never drives `fail` — over-budget is a `warn`. */
  rules: {
    onDisk: { bytes: number; lines: number };
    budget: { kb: number; maxLines: number };
    over: boolean;
  } | null;
  /** S10 host report. `null` when the project isn't initialized (no resolved
   *  host); otherwise carries the active `host` + the list of repo-relative
   *  primary artifact paths the doctor verified (AGENTS.md for agents-md/
   *  cursor/opencode; the host's native context file when distinct from
   *  AGENTS.md (claude → CLAUDE.md, gemini → GEMINI.md); the host's MCP
   *  config). The check row is `ok` when
   *  all present, `warn` (NEVER `fail`) when any are missing — re-running
   *  `noir sync` restores them. */
  host: { active: HostId; expected: string[]; missing: string[] } | null;
  /** S11 publish-readiness report (repo-developer-facing, advisory). `null`
   *  when doctor is NOT running from a monorepo checkout (a global install has
   *  no workspace package.json set to validate → the row reports `ok`
   *  "skipped"). Otherwise carries the count of workspace `package.json` files
   *  validated + the list of advisory issues found (bad semver, missing
   *  `files`, cli missing `bin`, …). The row severity is `warn` when any issues
   *  are present, `ok` otherwise — NEVER `fail` (a missing field does not break
   *  the local install). */
  publish: { checked: number; issues: string[] } | null;
  /** C1 install-method report. `method` from ~/.noir/install.json (fallback
   *  unknown); `latestKnown` from the update cache (never a live call). */
  install: {
    method: InstallMethod;
    installedVersion: string | null;
    latestKnown: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Best-effort probe of the `onnxruntime-node` native binding. */
async function probeOnnx(): Promise<{ ok: boolean; reason: string }> {
  try {
    // Variable specifier (not a string literal) so tsc does NOT try to resolve
    // a module the CLI package does not directly depend on — onnxruntime-node
    // is the context engine's dep and resolves through ITS node_modules at
    // runtime. Best-effort: hosts that hoist it resolve; otherwise not-loadable.
    const spec = 'onnxruntime-node';
    await import(spec);
    return { ok: true, reason: 'loadable' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Human label for the onnx probe outcome (hides confusing module-not-found noise). */
function describeOnnx(o: { ok: boolean; reason: string }): string {
  if (o.ok) return 'loadable';
  if (/Cannot find (module|package)/i.test(o.reason)) {
    return 'not resolvable from CLI probe (best-effort)';
  }
  const r = o.reason.length > 60 ? `${o.reason.slice(0, 59)}…` : o.reason;
  return `probe failed: ${r}`;
}

function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return 'unknown';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Checks. Each appends to `checks`; project-dependent ones short-circuit to a
// `warn` "skipped" row when the project isn't initialized (so the table still
// accounts for them, but a pre-init `noir doctor` never exit-1s on them).
// ---------------------------------------------------------------------------

async function checkRuntime(checks: CheckResult[]): Promise<void> {
  checks.push({
    name: 'runtime',
    status: 'ok',
    detail: `noir ${NOIR_VERSION} · node ${process.version} · ${process.platform}`,
  });
}

function checkConfig(root: string): { project: ProjectInfo | undefined; result: CheckResult } {
  const configPath = paths.config(root);
  if (!existsSync(configPath)) {
    return {
      project: undefined,
      result: {
        name: 'config',
        status: 'warn',
        detail: `no .noir/config.yml in ${root} — run \`noir init\``,
      },
    };
  }
  try {
    const project = loadProjectInfo(root);
    return {
      project,
      result: {
        name: 'config',
        status: 'ok',
        detail: `host=${project.config.host} · mode=${project.config.mode}`,
      },
    };
  } catch (e) {
    return {
      project: undefined,
      result: { name: 'config', status: 'fail', detail: `config parse error: ${msg(e)}` },
    };
  }
}

async function checkDaemon(checks: CheckResult[]): Promise<void> {
  const rec = readDaemonRecord();
  if (!rec) {
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: 'not running (start with `noir daemon start`)',
    });
    return;
  }
  if (!pidAlive(rec.pid)) {
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: `stale record (pid ${rec.pid} not alive)`,
    });
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/health`);
    const body =
      res.status === 200 ? ((await res.json()) as { ok?: boolean; uptimeSec?: number }) : null;
    if (body && body.ok === true) {
      checks.push({
        name: 'daemon',
        status: 'ok',
        detail: `running (pid ${rec.pid}, port ${rec.port}, up ${fmtUptime(body.uptimeSec ?? 0)})`,
      });
      return;
    }
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: `record present but /health unreachable on port ${rec.port}`,
    });
  } catch {
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: `record present but /health unreachable on port ${rec.port}`,
    });
  }
}

async function checkNativeDeps(checks: CheckResult[]): Promise<{ vecOk: boolean }> {
  // vecAvailability probes better-sqlite3 + sqlite-vec together (the store opens
  // a Database and loads sqlite-vec). Dynamic import keeps the native bindings
  // out of cold-start for every other command.
  const { vecAvailability } = await import('@noir-ai/store');
  const vec = vecAvailability();
  const onnx = await probeOnnx();
  const vecOk = vec.ok === true;
  const onnxOk = onnx.ok === true;
  // The sqlite side is CRITICAL (the store cannot open without it). onnx only
  // backs local embeddings, so its absence is a warning (search → BM25-only).
  const status: Severity = vecOk ? (onnxOk ? 'ok' : 'warn') : 'fail';
  checks.push({
    name: 'native deps',
    status,
    detail: `better-sqlite3+sqlite-vec: ${vecOk ? 'loadable' : vec.ok === false ? vec.reason : 'unknown'} · onnxruntime-node: ${describeOnnx(onnx)}`,
  });
  return { vecOk };
}

async function checkStore(
  checks: CheckResult[],
  project: ProjectInfo | undefined,
  root: string,
): Promise<void> {
  if (!project) {
    checks.push({ name: 'store', status: 'warn', detail: 'skipped — not initialized' });
    return;
  }
  const dbPath = paths.storeDb(root, project.id);
  if (!existsSync(dbPath)) {
    // Fresh project: the store DB is created LAZILY when the daemon first runs
    // (or when content is indexed) — `noir init`/`create` does not pre-create it.
    // Its absence on an otherwise-initialized project is EXPECTED, not a failure:
    // surfacing it as `fail` would alarm every new user on their first `noir doctor`.
    // Warn (never exit-1) with the action that materializes the store.
    checks.push({
      name: 'store',
      status: 'warn',
      detail: `not created yet — the store DB is created when the daemon first runs (\`noir daemon start\` or index content); expected at ${dbPath}`,
    });
    return;
  }
  const { openStore } = await import('@noir-ai/store');
  let store: { close(): Promise<void> | void } | undefined;
  try {
    store = await openStore({ projectId: project.id, root, readonly: true });
    checks.push({
      name: 'store',
      status: 'ok',
      detail: `opens readonly (db: ${paths.storeDb(root, project.id)})`,
    });
  } catch (e) {
    checks.push({ name: 'store', status: 'fail', detail: `open failed: ${msg(e)}` });
  } finally {
    if (store) {
      try {
        await Promise.resolve(store.close());
      } catch {
        /* a close error must not mask the open result */
      }
    }
  }
}

function checkEmbedder(
  checks: CheckResult[],
  project: ProjectInfo | undefined,
  vecOk: boolean,
): void {
  if (!project) {
    checks.push({ name: 'embedder', status: 'warn', detail: 'skipped — not initialized' });
    return;
  }
  const emb = project.config.context.embedder;
  const kind = emb.kind;
  const model = typeof emb.model === 'string' && emb.model.length > 0 ? emb.model : '<unset>';
  if (kind === 'none') {
    checks.push({
      name: 'embedder',
      status: 'ok',
      detail: `kind=none (BM25-only) · dim=${emb.dim}`,
    });
    return;
  }
  if (!vecOk) {
    // vec native layer is the embedder's hard prereq (vecs write into vec0).
    checks.push({
      name: 'embedder',
      status: 'warn',
      detail: `${kind}/${model} (${emb.dim}-dim) configured but vec native layer unavailable — search degrades to BM25`,
    });
    return;
  }
  checks.push({
    name: 'embedder',
    status: 'ok',
    detail: `${kind}/${model} (${emb.dim}-dim) · vec backend available`,
  });
}

function checkProvider(checks: CheckResult[], project: ProjectInfo | undefined): void {
  if (!project) {
    checks.push({ name: 'provider', status: 'warn', detail: 'skipped — not initialized' });
    return;
  }
  // PURE projection — resolveModelConfig reads config + env-var NAMES only; it
  // NEVER makes a live call and NEVER infers a provider from env-var presence.
  const resolved = resolveModelConfig(project.config.model);
  const names = Object.keys(resolved.providers);
  if (names.length === 0) {
    checks.push({
      name: 'provider',
      status: 'ok',
      detail: 'none configured (offline mode; drafting degrades to templates)',
    });
    return;
  }
  const parts: string[] = [];
  let missing = false;
  for (const name of names) {
    const p = resolved.providers[name];
    if (!p) continue;
    const key = p.hasKey ? 'key present' : p.apiKeyEnv ? `missing ${p.apiKeyEnv}` : 'anonymous';
    if (!p.hasKey && p.apiKeyEnv) missing = true;
    parts.push(`${name}/${p.model ?? '?'} (${key})`);
  }
  // Provider readiness is never CRITICAL — the model layer degrades to `null`
  // (templates) when a key is missing, so this is an ok/warn signal only.
  checks.push({
    name: 'provider',
    status: missing ? 'warn' : 'ok',
    detail: parts.join(' · '),
  });
}

// ---------------------------------------------------------------------------
// C1 — doctor install row (advisory; ok/warn only, never fail, cache-only).
// ---------------------------------------------------------------------------

export interface InstallCheckOutcome {
  name: 'install';
  status: 'ok' | 'warn';
  detail: string;
  method: InstallMethod;
  installedVersion: string | null;
  latestKnown: string | null;
}

/** Pure: build the doctor `install` row. NEVER `fail` — an install method issue
 *  is advisory, not a broken host. Reads the cache only; no network. */
export function buildInstallCheck(opts: {
  method: InstallMethod;
  version: string | null;
  latestKnown: string | null;
}): InstallCheckOutcome {
  const { method, version, latestKnown } = opts;
  const parts: string[] = [`method=${method}`];
  if (version) parts.push(`v${version}`);
  const advisory: string[] = [];
  if (method !== 'native') advisory.push('native recommended');
  if (latestKnown && version && latestKnown !== version) advisory.push('update available');
  const status: 'ok' | 'warn' = advisory.length > 0 ? 'warn' : 'ok';
  if (advisory.length > 0) parts.push(advisory.join(' + '));
  return {
    name: 'install',
    status,
    detail: parts.join(' · '),
    method,
    installedVersion: version,
    latestKnown,
  };
}

function checkScaffoldVersion(
  checks: CheckResult[],
  root: string,
): {
  onDisk: string | null;
  current: string;
  drift: boolean;
} {
  // readScaffoldVersion never throws — it returns null on an absent/malformed
  // stamp, so doctor keeps reporting even on a partially-initialized project.
  const onDisk = readScaffoldVersion(root);
  const current = CURRENT_SCAFFOLD_VERSION;
  const drift = onDisk !== null && onDisk !== current;
  // Drift is NEVER critical: a stale scaffold still works (the manifest entries
  // are forward-compatible), it just means `noir init --upgrade` will run
  // pending migrations. Absent stamp on an uninitialized project → warn (parity
  // with the other project-dependent checks that skip-with-warn pre-init).
  const status: Severity = onDisk === null || drift ? 'warn' : 'ok';
  const detail =
    onDisk === null
      ? 'no .noir/scaffold-version stamp (run `noir init`)'
      : drift
        ? `on-disk ${onDisk} ≠ current ${current} (run \`noir init --upgrade\`)`
        : `${onDisk} (up to date)`;
  checks.push({ name: 'scaffold version', status, detail });
  return { onDisk, current, drift };
}

/**
 * Soft RULES.md budget cap. Mirrors the Failure-Backed Rules doctrine:
 * an over-budget RULES.md tends to accumulate stale / speculative clauses, so
 * doctor warns (NEVER fails — purely a hygiene nudge) when the file exceeds
 * the configured `lengthBudgetKb` (default 6 KB) OR a 150-line ceiling. The
 * check is honest about the three "nothing to measure" cases:
 *
 *   • project not initialized  → skip-warn (parity with store/embedder/provider)
 *   • RULES.md absent          → ok informational (no file = no budget problem)
 *   • RULES.md unreadable      → warn (treat like a malformed-stamp: surface it)
 *
 * Returns the structured measurement for the `--json` envelope's `data.rules`,
 * or `null` when there is nothing to measure (absent / skipped).
 */
function checkRulesMdBudget(
  checks: CheckResult[],
  root: string,
  project: ProjectInfo | undefined,
): {
  onDisk: { bytes: number; lines: number };
  budget: { kb: number; maxLines: number };
  over: boolean;
} | null {
  if (!project) {
    checks.push({ name: 'rules budget', status: 'warn', detail: 'skipped — not initialized' });
    return null;
  }
  const rulesPath = paths.rulesMd(root);
  if (!existsSync(rulesPath)) {
    // No RULES.md is fine — most projects don't have one yet. Informational ok
    // so a green run stays green without forcing a file creation.
    checks.push({
      name: 'rules budget',
      status: 'ok',
      detail: 'no .noir/rules/RULES.md',
    });
    return null;
  }
  // Read + measure. A read/decode failure surfaces as a warn (parallel to the
  // malformed-stamp handling in checkScaffoldVersion): the doctor keeps
  // reporting rather than crashing, and the user sees a clear hint.
  let content: string;
  try {
    content = readFileSync(rulesPath, 'utf8');
  } catch (e) {
    checks.push({
      name: 'rules budget',
      status: 'warn',
      detail: `RULES.md unreadable: ${msg(e)}`,
    });
    return null;
  }
  // bytes = UTF-8 file size on disk (the natural unit for a KB budget). lines
  // uses wc-style counting: count of '\n' chars, +1 if the last line has no
  // trailing newline; 0 only for an empty file.
  const bytes = Buffer.byteLength(content, 'utf8');
  const lineCount =
    content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  const lengthBudgetKb = project.config.rules.lengthBudgetKb;
  const budgetBytes = lengthBudgetKb * 1024;
  const maxLines = 150;
  const overBytes = bytes > budgetBytes;
  const overLines = lineCount > maxLines;
  const over = overBytes || overLines;
  const status: Severity = over ? 'warn' : 'ok';
  const kb = (n: number): string => (n / 1024).toFixed(1);
  const detail = over
    ? `OVER: ${kb(bytes)} KB / ${lengthBudgetKb} KB · ${lineCount}/${maxLines} lines — trim RULES.md (failure-backed clauses only) or raise rules.lengthBudgetKb`
    : `${kb(bytes)} KB / ${lengthBudgetKb} KB · ${lineCount}/${maxLines} lines (within budget)`;
  checks.push({ name: 'rules budget', status, detail });
  return {
    onDisk: { bytes, lines: lineCount },
    budget: { kb: lengthBudgetKb, maxLines },
    over,
  };
}

function summarize(checks: CheckResult[]): DoctorPayload['summary'] {
  let ok = 0;
  let warnN = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.status === 'ok') ok++;
    else if (c.status === 'warn') warnN++;
    else fail++;
  }
  return { ok, warn: warnN, fail };
}

/**
 * S10 — host-artifacts presence check. Reports the ACTIVE host (read from
 * `project.config.host`) + verifies the host's primary emission paths exist on
 * disk. The expected set mirrors `buildHostArtifacts` in @noir-ai/create:
 *
 *   - AGENTS.md for the hosts that emit it (agents-md/cursor/opencode — their
 *     native context surface IS AGENTS.md). claude/gemini do NOT emit AGENTS.md
 *     (their CLAUDE.md/GEMINI.md @-import the canonical .noir/ sources; a root
 *     AGENTS.md would double-import them — fix-wave I1 removed that delta).
 *   - The host's native context file when distinct from AGENTS.md
 *     (claude → CLAUDE.md; gemini → GEMINI.md; agents-md/cursor/opencode →
 *     none, AGENTS.md IS the context). Cursor's working-rules ride AGENTS.md's
 *     `@.noir/rules/RULES.md` import — NO separate `.cursor/rules/noir-contract.mdc`
 *     host-rules pointer (it was `noir-`-prefixed and the C3 cursor flat-skill
 *     prune deleted it on every sync).
 *   - The host's MCP config (.mcp.json / .gemini/mcp.json / .cursor/mcp.json /
 *     opencode.json).
 *
 * Severity is `ok` when every expected path exists, `warn` when any are
 * missing (NEVER `fail` — a missing host artifact is restored by `noir sync`,
 * not a critical product failure). Mirrors the policy of the other
 * presence/projection checks (scaffold-version drift, RULES.md budget): warn,
 * surface the remediation, never block.
 *
 * Returns the structured payload for the `--json` envelope's `data.host`, or
 * `null` when the project isn't initialized (no resolved host).
 */
function checkHostArtifacts(
  checks: CheckResult[],
  root: string,
  project: ProjectInfo | undefined,
): { active: HostId; expected: string[]; missing: string[] } | null {
  if (!project) {
    checks.push({ name: 'host artifacts', status: 'warn', detail: 'skipped — not initialized' });
    return null;
  }
  const host = project.config.host;
  const adapter = resolveAdapter(host);
  const ectx = { root };

  // Build the expected repo-relative path list. Mirrors buildHostArtifacts in
  // @noir-ai/create so a missing row maps 1:1 to a manifest entry the user can
  // restore with `noir sync`. Kept inline (not imported) so doctor stays a
  // READ-ONLY health probe with zero write-side coupling.
  const expected: string[] = [];
  // AGENTS.md — only for hosts whose emitContext IS the AGENTS.md (I1: claude/
  // gemini skip it — their native context file already covers .noir/).
  const emitsAgentsMd = host === 'agents-md' || host === 'cursor' || host === 'opencode';
  if (emitsAgentsMd) {
    expected.push(relOr(adapter.agentsMdPath?.(ectx) ?? 'AGENTS.md', root));
  }
  // Host-native context file (when distinct from AGENTS.md).
  if (host === 'claude') expected.push('CLAUDE.md');
  else if (host === 'gemini') expected.push('GEMINI.md');
  // Cursor has NO separate host-rules .mdc — the prior `noir-contract.mdc`
  // pointer was REMOVED (it was `noir-`-prefixed, so the C3 cursor flat-skill
  // prune in emitSkillsToDir deleted it on every noir init/create/sync).
  // Cursor's rules ride AGENTS.md's `@.noir/rules/RULES.md` import instead.
  // Host MCP config (fallback .mcp.json for claude/agents-md).
  expected.push(relOr(adapter.mcpConfigPath?.(ectx) ?? '.mcp.json', root));

  const missing = expected.filter((p) => !existsSync(joinRoot(root, p)));
  const status: Severity = missing.length === 0 ? 'ok' : 'warn';
  const detail =
    missing.length === 0
      ? `host=${host} · all ${expected.length} primary artifacts present`
      : `host=${host} · missing ${missing.join(', ')} (run \`noir sync\` to restore)`;
  checks.push({ name: 'host artifacts', status, detail });
  return { active: host, expected, missing };
}

// ---------------------------------------------------------------------------
// SP-A — nested-`.noir` detection (read-only).
// ---------------------------------------------------------------------------

/**
 * Detects the fingerprint of a `noir init`/`create` run from INSIDE `.noir/`
 * (now PREVENTED by `assertSafeRoot` in @noir-ai/create, but legacy/already-
 * nested projects still carry the damage): a nested `<root>/.noir/.noir/` store
 * and/or host artifacts emitted into `.noir/` as if it were a project root
 * (`.noir/CLAUDE.md`, `.noir/.mcp.json`, `.noir/.claude/`, and the ignore files
 * `.noir/.gitignore` / `.dockerignore` / `.npmignore` / `.prettierignore`).
 * Read-only `warn` —
 * doctor never mutates; remediation is manual removal (a future follow-up
 * slice can automate it). Never `fail`: a nested store wastes space + confuses
 * tooling but does not break the outer project.
 */
export function checkNestedNoir(
  checks: CheckResult[],
  root: string,
): { detected: boolean; paths: string[] } {
  const candidates = [
    '.noir/.noir',
    '.noir/CLAUDE.md',
    '.noir/.mcp.json',
    '.noir/.claude',
    '.noir/.gitignore',
    '.noir/.dockerignore',
    '.noir/.npmignore',
    '.noir/.prettierignore',
  ];
  const found = candidates.filter((rel) => existsSync(join(root, rel)));
  const detected = found.length > 0;
  checks.push({
    name: 'nested .noir',
    status: detected ? 'warn' : 'ok',
    detail: detected
      ? `nested Noir artifacts inside .noir/ (${found.join(', ')}) — likely from running \`noir init\` inside .noir/. Remove them; the real project is at ${root}.`
      : 'no nested .noir/ artifacts',
  });
  return { detected, paths: found };
}

// ---------------------------------------------------------------------------
// SP-C deferred — semantic duplicate detection (`--dedup`; loads the embedder).
// ---------------------------------------------------------------------------

/** Local embedder shape (@noir-ai/context's `EmbedFn`). */
type EmbedLike = (text: string) => Promise<Float32Array>;

/**
 * Collect dedup candidates: the host context files that exist at the root
 * (CLAUDE.md / AGENTS.md / GEMINI.md — the hand-mirrored-overlap case) plus
 * `.noir/rules/RULES.md`. `.noir/NOIR.md` is EXCLUDED because host context
 * files `@import` it by design (their similarity is intentional, not a dup).
 */
export function collectDedupCandidates(root: string): { path: string; text: string }[] {
  const rels = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.noir/rules/RULES.md'];
  const out: { path: string; text: string }[] = [];
  for (const rel of rels) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.trim().length === 0) continue;
    out.push({ path: rel, text });
  }
  return out;
}

/**
 * `noir doctor --dedup`: embed the host-context + RULES.md candidates and
 * report near-duplicate pairs (cosine ≥ 0.90). The ONLY mechanism that catches
 * cross-file SEMANTIC overlap (e.g. a hand-mirrored CLAUDE.md ≈ AGENTS.md) —
 * exact content-hash cannot. Opt-in so a default `noir doctor` never pays the
 * embedder-load cost; degrades to a `warn` skip when the embedder is
 * unavailable (kind=none / native layer missing). `opts.embed` is a testability
 * seam — tests inject a deterministic fake; production omits it and the local
 * embedder is lazy-loaded via `@noir-ai/context`.
 */
export async function checkSemanticDupDoctor(
  checks: CheckResult[],
  root: string,
  project: ProjectInfo | undefined,
  opts: { embed?: EmbedLike } = {},
): Promise<void> {
  if (!project) {
    checks.push({ name: 'semantic dup', status: 'warn', detail: 'skipped — not initialized' });
    return;
  }
  const candidates = collectDedupCandidates(root);
  if (candidates.length < 2) {
    checks.push({
      name: 'semantic dup',
      status: 'ok',
      detail: `${candidates.length} candidate file(s); nothing to compare`,
    });
    return;
  }
  const ctx = await import('@noir-ai/context');
  let embed: EmbedLike | undefined = opts.embed;
  if (!embed) {
    const cfg = ctx.resolveEmbedderConfig(project.config.context);
    if (cfg.kind === 'none') {
      checks.push({
        name: 'semantic dup',
        status: 'warn',
        detail: 'embedder kind=none — set context.embedder.kind=local to enable semantic dedup',
      });
      return;
    }
    try {
      embed = ctx.createEmbedFn(cfg).embed as EmbedLike;
    } catch (e) {
      checks.push({
        name: 'semantic dup',
        status: 'warn',
        detail: `embedder unavailable — skipped (${msg(e)})`,
      });
      return;
    }
  }
  if (!embed) return;
  const pairs = await ctx.findSemanticDuplicates(candidates, embed, ctx.DEFAULT_DUP_THRESHOLD);
  checks.push({
    name: 'semantic dup',
    status: pairs.length > 0 ? 'warn' : 'ok',
    detail:
      pairs.length === 0
        ? `no near-duplicates across ${candidates.length} file(s)`
        : `${pairs.length} near-duplicate pair${pairs.length === 1 ? '' : 's'}: ${pairs
            .map((p) => `${p.a}≈${p.b} (${p.similarity.toFixed(2)})`)
            .join('; ')}`,
  });
}

// ---------------------------------------------------------------------------
// S11 — publish-readiness check (advisory, repo-developer-facing).
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace `packages/` directory from the CLI's own location —
 * walk up from `import.meta.url` to the nearest `package.json` named
 * `@noir-ai/cli`, then return its PARENT dir (the `packages/` root) IF that
 * dir's parent carries the monorepo marker (`pnpm-workspace.yaml`). Returns
 * `null` when not running from a monorepo checkout (a global `npm install -g`
 * has no `packages/*` workspace to validate → the publish check skips).
 *
 * The walk is robust across layouts: source (`packages/cli/src/commands/`),
 * built (`packages/cli/dist/`), and bundled-chunk (`packages/cli/dist/`) all
 * walk up to `packages/cli/package.json`. In a global install the same walk
 * lands on `node_modules/@noir-ai/cli/package.json`, whose parent
 * (`node_modules/@noir-ai/`) has NO `pnpm-workspace.yaml` parent → null.
 */
function resolveWorkspacePackagesDir(): string | null {
  let here = dirname(fileURLToPath(import.meta.url));
  // Bound the walk so a pathological layout never loops the filesystem.
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(here, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === '@noir-ai/cli') {
          // `here` is the cli package dir; `dirname(here)` is `packages/`.
          const packagesDir = dirname(here);
          // Monorepo gate: the repo root (`dirname(packagesDir)`) carries
          // `pnpm-workspace.yaml`. A global install fails this gate.
          if (existsSync(join(dirname(packagesDir), 'pnpm-workspace.yaml'))) {
            return packagesDir;
          }
          return null;
        }
      } catch {
        // Malformed package.json — keep walking.
      }
    }
    const parent = dirname(here);
    if (parent === here) break; // filesystem root
    here = parent;
  }
  return null;
}

/**
 * Permissive semver-ish regex for the advisory check. Accepts release and
 * pre-release/build forms (`1.0.0`, `1.1.0-beta.1`, `1.2.0+build.4`). Strict
 * enough to catch the obvious foot-guns (a git SHA, a literal "latest", a
 * missing patch) without pulling in the `semver` package for a warn-level
 * check. `npm publish` itself enforces rigor at pack time.
 */
const SEMVER_ISH = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Best-effort `npm pack --dry-run` on the cli package — read-only (it does
 *  NOT write the tarball). Returns `{ fileCount, distIncluded }` parsed from
 *  npm's notice output, or `{ error }` when npm is unavailable / the pack
 *  fails. Gated on npm being on PATH (the spec's expensive-but-optional leg):
 *  we probe `npm --version` first and skip-with-note if it isn't resolvable. */
function npmPackDryRun(
  cliPkgDir: string,
): { fileCount: number | null; distIncluded: boolean | null } | { error: string } {
  // Probe npm availability first (cheap). shell:true so Windows finds npm.cmd.
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: true });
  if (probe.status !== 0 || probe.error) {
    return { error: probe.error ? probe.error.message : 'npm not on PATH' };
  }
  // `npm pack --dry-run` lists the tarball contents without writing the file.
  // It IS read-only (npm's own docs: "--dry-run ... does not write anything").
  const res = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: cliPkgDir,
    encoding: 'utf8',
    shell: true,
  });
  if (res.status !== 0 || res.error) {
    return { error: res.error ? res.error.message : `npm pack exited ${res.status ?? '?'}` };
  }
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  // `npm notice total files: 42` — the canonical summary line.
  const totalMatch = out.match(/total files:\s*(\d+)/i);
  const fileCount = totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) : null;
  // `dist/` appears in the tarball contents (`npm notice <size> dist/<file>`).
  const distIncluded = /\bdist\//.test(out);
  return { fileCount, distIncluded };
}

/**
 * S11 publish-readiness check. For every workspace `package.json` under
 * `packagesDir`, validate publishability:
 *   - `name` starts with `@noir-ai/`
 *   - `version` matches {@link SEMVER_ISH}
 *   - `files` is a non-empty array
 *   - the cli package has a `bin` field
 *
 * Optionally runs `npm pack --dry-run` on the cli package (best-effort, gated
 * on npm being available) to report the file count + confirm `dist/` ships.
 *
 * Severity is ALWAYS `ok` or `warn` — NEVER `fail`: a missing/odd package.json
 * field does not break the local install (this is an advisory nudge to repo
 * developers, not a project-facing health check). The check runs ALWAYS (it
 * produces a row in every doctor report) but returns `null` from
 * `data.publish` when not running from a monorepo (`packagesDir === null`).
 */
export function checkPublish(
  checks: CheckResult[],
  packagesDir: string | null,
  opts: { skipNpmPack?: boolean } = {},
): { checked: number; issues: string[] } | null {
  if (packagesDir === null) {
    checks.push({
      name: 'publish',
      status: 'ok',
      detail: 'skipped — not a monorepo checkout (no packages/* workspace)',
    });
    return null;
  }
  // Discover workspace package.json files (depth-1 dirs only — no glob dep).
  let entries: string[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    checks.push({
      name: 'publish',
      status: 'warn',
      detail: `could not read ${packagesDir}: ${msg(e)}`,
    });
    return { checked: 0, issues: [`unreadable packages dir: ${msg(e)}`] };
  }

  const issues: string[] = [];
  let checked = 0;
  let cliDir: string | null = null;
  for (const name of entries) {
    const pkgPath = join(packagesDir, name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      issues.push(`${name}/package.json: unparseable (${msg(e)})`);
      checked++;
      continue;
    }
    checked++;
    const pkgName = typeof pkg.name === 'string' ? pkg.name : '';
    if (!pkgName.startsWith('@noir-ai/')) {
      issues.push(`${name}/package.json: name '${pkgName}' is not @noir-ai/*`);
    }
    const version = typeof pkg.version === 'string' ? pkg.version : '';
    if (!SEMVER_ISH.test(version)) {
      issues.push(`${name}/package.json: version '${version}' is not semver`);
    }
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
      issues.push(`${name}/package.json: files missing or empty`);
    }
    if (pkgName === '@noir-ai/cli') {
      if (pkg.bin == null || (typeof pkg.bin === 'object' && Object.keys(pkg.bin).length === 0)) {
        issues.push(`${name}/package.json: bin missing (cli package must declare a bin)`);
      }
      cliDir = join(packagesDir, name);
    }
  }

  // Best-effort npm pack --dry-run on the cli package. Gated on npm being
  // available; a failure here is surfaced in the detail but does NOT add an
  // issue (it is environmental, not a package.json defect). `skipNpmPack` is a
  // testability seam — synthetic test fixtures have no real `dist/`, so the
  // dist-absent signal would otherwise pollute the package.json-validation
  // assertions. Production (`doctor()`) leaves it unset.
  let packNote = '';
  if (cliDir && opts.skipNpmPack !== true) {
    const pack = npmPackDryRun(cliDir);
    if ('error' in pack) {
      packNote = ` · npm pack skipped (${pack.error})`;
    } else {
      const count = pack.fileCount == null ? '?' : String(pack.fileCount);
      const dist = pack.distIncluded ? 'dist/ included' : 'dist/ NOT in tarball';
      packNote = ` · npm pack: ${count} files, ${dist}`;
      if (pack.distIncluded === false) {
        issues.push('cli npm pack --dry-run: dist/ absent from the tarball');
      }
    }
  }

  const status: Severity = issues.length > 0 ? 'warn' : 'ok';
  const detail =
    issues.length === 0
      ? `${checked}/${entries.length} packages publish-ready${packNote}`
      : `${issues.length} issue${issues.length === 1 ? '' : 's'} across ${checked} package${checked === 1 ? '' : 's'}${packNote}`;
  checks.push({ name: 'publish', status, detail });
  return { checked, issues };
}

/** Repo-relative POSIX form of `abs` under `root`. Defensive (N2): rejects
 *  paths that escape `root` — mirrors `hostRel` in @noir-ai/create/manifest.ts.
 *  A future adapter that returns a stray path fails loudly here instead of
 *  producing a misleading "missing" row for a path doctor would never probe.
 *  Relative literals (e.g. `'AGENTS.md'`, `'.mcp.json'`) pass through unchanged
 *  AFTER the `..`-escape check so a buggy literal could not exfiltrate either. */
function relOr(abs: string, root: string): string {
  const posix = abs.replace(/\\/g, '/');
  if (posix.startsWith('/')) {
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (rel.length === 0 || rel.startsWith('..') || rel.startsWith('/')) {
      throw new Error(`doctor: host path '${abs}' is not under root '${root}'`);
    }
    return rel;
  }
  // Already-relative literal: still reject `..` segments (a `../etc/passwd`
  // literal from a buggy adapter must not silently pass through).
  if (posix.split('/').some((seg) => seg === '..')) {
    throw new Error(`doctor: host path '${abs}' escapes root '${root}'`);
  }
  return posix;
}

/** Join `root` with a repo-relative POSIX path for an existsSync probe. */
function joinRoot(root: string, relPath: string): string {
  return `${root}/${relPath}`;
}

function severityBadge(s: Severity): string {
  // Doctor's vocabulary is ok/warn/fail; the badge palette is ok/warn/error/info.
  // `fail` is the CRITICAL state → red (`error`), so RED stays reserved for the
  // broken-host states. The TEXT label keeps doctor's own uppercase word so the
  // JSON envelope (`status: 'fail'`) and the human row agree on vocabulary.
  const state: BadgeState = s === 'fail' ? 'error' : s;
  return badge(state, s.toUpperCase());
}

function renderHuman(payload: DoctorPayload, opts: CliOptions): void {
  log(
    `noir doctor — ${payload.checks.length} check${payload.checks.length === 1 ? '' : 's'}`,
    opts,
  );
  table(
    payload.checks.map((c) => ({
      Check: c.name,
      Status: severityBadge(c.status),
      Detail: c.detail,
    })),
    ['Check', 'Status', 'Detail'],
    opts,
  );
  const { ok, warn: warnN, fail } = payload.summary;
  if (fail > 0) {
    err(
      `${fail} critical check${fail === 1 ? '' : 's'} failed (${warnN} warning${warnN === 1 ? '' : 's'}, ${ok} ok)`,
      opts,
    );
  } else if (warnN > 0) {
    warn(`all critical checks passed (${warnN} warning${warnN === 1 ? '' : 's'}, ${ok} ok)`, opts);
  } else {
    success(`all ${ok} check${ok === 1 ? '' : 's'} passed`, opts);
  }
}

/**
 * `noir doctor`: run all checks, render, and exit.
 *
 * Under `--json` writes `{ok:true, data: DoctorPayload}` to stdout (always —
 * the command produced a diagnosis). The exit code carries health: 0 when no
 * check failed, 1 when any CRITICAL (`fail`) check is unhealthy.
 */
export async function doctor(opts: DoctorOptions = {}): Promise<void> {
  const root = process.cwd();
  const checks: CheckResult[] = [];

  await checkRuntime(checks);
  const { project, result: configResult } = checkConfig(root);
  checks.push(configResult);
  await checkDaemon(checks);
  const { vecOk } = await checkNativeDeps(checks);
  await checkStore(checks, project, root);
  checkEmbedder(checks, project, vecOk);
  checkProvider(checks, project);
  const scaffold = checkScaffoldVersion(checks, root);
  const rules = checkRulesMdBudget(checks, root, project);
  const host = checkHostArtifacts(checks, root, project);
  checkNestedNoir(checks, root);
  if (opts.dedup === true) {
    await checkSemanticDupDoctor(checks, root, project);
  }
  const publish = checkPublish(checks, resolveWorkspacePackagesDir());

  // C1 — install-method check (advisory, cache-only, never fail).
  const installCheck = buildInstallCheck({
    method: detectActiveMethod(),
    version: readInstallRecord()?.version ?? null,
    latestKnown: latestVersionFromCache(readUpdateCache(), 'latest'),
  });
  checks.push(installCheck);

  const summary = summarize(checks);
  const payload: DoctorPayload = {
    noir: NOIR_VERSION,
    checks,
    summary,
    scaffold,
    rules,
    host,
    publish,
    install: {
      method: installCheck.method,
      installedVersion: installCheck.installedVersion,
      latestKnown: installCheck.latestKnown,
    },
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: payload })}\n`);
  } else {
    renderHuman(payload, opts);
  }

  if (summary.fail > 0) {
    // Under --json the data envelope is already on stdout; throw with an empty
    // message so handleError sets exitCode=1 without a redundant stderr line.
    // Under human mode the summary line above already named the failures.
    throw new NoirCliError(
      EXIT.ERROR,
      opts.json === true ? '' : `noir doctor: ${summary.fail} critical check(s) failed`,
    );
  }
}
