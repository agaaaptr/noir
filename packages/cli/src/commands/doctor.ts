// S9 t6 — `noir doctor`.
//
// Environment + project health. Runs a fixed set of checks and renders a
// results table (human, stderr) or the versioned `{ok,data}` envelope (--json,
// stdout). Exit 1 if any CRITICAL (fail) check is unhealthy, else 0.
//
// Severity model (S9 spec F8 / t6):
//   - ok   — healthy.
//   - warn — degraded but usable (daemon down, onnx missing, provider key
//            missing, project not initialized). NEVER triggers exit 1.
//   - fail — CRITICAL: the product is broken on this host. Only `config` (parse
//            error), `native deps` (better-sqlite3 / sqlite-vec will not load),
//            and `store` (open fails) can fail. Exit 1 if any fail.
//
// Honesty rules: provider status uses `resolveModelConfig` — a PURE projection
// of the user's config + env-var NAME presence; it makes NO live call (blueprint
// D5/DS-6). Native-dep probes are best-effort try/catch (the store's native
// binaries are probed via `vecAvailability`, the single cross-package surface;
// onnxruntime-node is the context engine's own dep and is probed separately).
//
// Cold-start (NF6): the @noir-ai/store import (which loads better-sqlite3) is
// DYNAMIC, inside the action, so merely running `noir status` / `noir --help`
// never pays the native-bindings cost. @noir-ai/model is imported eagerly — its
// provider self-registration is light (SDKs load lazily inside `complete()`).
//
// Stream discipline (S9 DS-4): `--json` writes `{ok:true, data:{checks,summary}}`
// to stdout (the only stdout write). Doctor always emits `ok:true` because the
// COMMAND succeeded in producing a diagnosis; the system-health pass/fail is
// signaled by the EXIT CODE (0 healthy / 1 critical failure) — the same shape
// `npm audit --json` uses (valid JSON out, non-zero exit when issues found).

import { existsSync } from 'node:fs';
import { loadProjectInfo, NOIR_VERSION, type ProjectInfo, paths } from '@noir-ai/core';
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

/** Options accepted by `doctor` (the global flags only). */
export interface DoctorOptions extends CliOptions {}

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

function renderHuman(payload: DoctorPayload, opts: CliOptions): void {
  log(
    `noir doctor — ${payload.checks.length} check${payload.checks.length === 1 ? '' : 's'}`,
    opts,
  );
  table(
    payload.checks.map((c) => ({
      Check: c.name,
      Status: c.status.toUpperCase(),
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

  const summary = summarize(checks);
  const payload: DoctorPayload = { noir: NOIR_VERSION, checks, summary, scaffold };

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
