// `noir workspace *` + the `--workspace` branch of `noir daemon start` + `noir daemon join`.
//
// A workspace is a named cross-repo sharing unit. `daemon start --workspace <name>`
// founds/joins it from the current repo and starts the detached workspace daemon;
// `daemon join <name>` joins it from another repo. `workspace list/status/leave/stop`
// manage membership. Joining writes a `.noir/workspace.json` marker + rewrites the
// repo's `.mcp.json` `noir` entry to a stdio entry naming the workspace (the host
// then reaches the shared daemon through the bridge); leaving reverses both.
// Default transport (stdio) and project behavior are untouched unless a repo
// explicitly joins.
import { readdirSync } from 'node:fs';
import {
  clearWorkspaceMarker,
  ensureWorkspaceRegistry,
  isValidWorkspaceName,
  isWorkspaceMember,
  loadProjectInfo,
  type ProjectInfo,
  readWorkspaceMarker,
  readWorkspaceRegistry,
  removeWorkspaceMember,
  upsertWorkspaceMember,
  workspaceHomeDir,
  writeWorkspaceMarker,
} from '@noir-ai/core';
import {
  clearWorkspaceDaemonRecord,
  ensureWorkspaceDaemonRunning,
  pidAlive,
  readWorkspaceDaemonRecord,
  spawnDetachedWorkspaceDaemon,
} from '@noir-ai/daemon';
import { type CliOptions, EXIT, fail, info, log } from '../output.js';
import { verifyWorkspaceDaemon, type WorkspaceDaemonHealth } from '../workspace-bridge.js';
import { writeStdioEntry, writeWorkspaceEntry } from '../workspace-mcp.js';

export interface WorkspaceStartOptions extends CliOptions {
  name: string;
  detach?: boolean;
  detachChild?: boolean;
  force?: boolean;
}
export interface WorkspaceJoinOptions extends CliOptions {
  name: string;
  force?: boolean;
}
export interface WorkspaceStatusOptions extends CliOptions {
  name?: string;
}
export interface WorkspaceLeaveOptions extends CliOptions {
  force?: boolean;
}

function loadProjectOrFail(opts: CliOptions): ProjectInfo {
  try {
    return loadProjectInfo(process.cwd());
  } catch {
    fail(EXIT.ERROR, 'Noir is not initialized in this directory. Run `noir init` first.', opts);
  }
}

// Membership is recorded by the marker; the `noir` MCP entry stays on stdio and
// names the workspace, so the host reaches the shared daemon through the bridge
// without any address or token landing in the repo's config.
function finishJoin(
  project: ProjectInfo,
  name: string,
  opts: CliOptions & { force?: boolean },
): void {
  writeWorkspaceMarker(project.root, name);
  writeWorkspaceEntry(project.root, project.config.host, name, opts);
}

/** `noir daemon start --workspace <name>` — found a workspace + start its daemon. */
export async function daemonStartWorkspace(opts: WorkspaceStartOptions): Promise<void> {
  const project = loadProjectOrFail(opts);
  if (!isValidWorkspaceName(opts.name)) {
    fail(
      EXIT.USAGE,
      `invalid workspace name ${JSON.stringify(opts.name)} (lowercase letters, digits, and dashes).`,
      opts,
    );
  }
  // Found/join: register THIS repo as a member (idempotent by projectId).
  upsertWorkspaceMember(ensureWorkspaceRegistry(opts.name), {
    projectId: project.id,
    root: project.root,
    joinedAt: Date.now(),
  });

  // Detached-child path (set by spawnDetachedWorkspaceDaemon): run in-process.
  if (opts.detachChild === true) {
    const ensured = await ensureWorkspaceDaemonRunning({
      name: opts.name,
      project,
      idleTimeoutSec: project.config.workspace.idleTimeoutSec,
    });
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { mode: 'detached' } })}\n`);
      return;
    }
    info('noir workspace daemon: detached foreground. Ctrl+C to stop.', opts);
    log(`workspace daemon listening at ${ensured.url}`, opts);
    return;
  }

  // --detach: fork a detached child; the parent writes the marker + .mcp.json.
  if (opts.detach === true) {
    const spawned = await spawnDetachedWorkspaceDaemon({ name: opts.name, project });
    finishJoin(project, opts.name, opts);
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { mode: 'detached', pid: spawned.pid, port: spawned.port } })}\n`,
      );
      return;
    }
    info(
      `workspace "${opts.name}" daemon started (pid ${spawned.pid}, port ${spawned.port}).`,
      opts,
    );
    return;
  }

  // Foreground: the workspace server keeps this process alive.
  const ensured = await ensureWorkspaceDaemonRunning({
    name: opts.name,
    project,
    idleTimeoutSec: project.config.workspace.idleTimeoutSec,
  });
  finishJoin(project, opts.name, opts);
  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { url: ensured.url, port: ensured.port, reused: !ensured.started } })}\n`,
    );
    return;
  }
  info('noir workspace daemon: foreground mode. Ctrl+C to stop.', opts);
  log(`workspace daemon listening at ${ensured.url}`, opts);
}

/** `noir daemon join <name>` — join an existing workspace from this repo. */
export async function daemonJoin(opts: WorkspaceJoinOptions): Promise<void> {
  const project = loadProjectOrFail(opts);
  if (!isValidWorkspaceName(opts.name)) {
    fail(EXIT.USAGE, `invalid workspace name ${JSON.stringify(opts.name)}.`, opts);
  }
  const reg = readWorkspaceRegistry(opts.name);
  if (!reg) {
    fail(
      EXIT.ERROR,
      `workspace ${JSON.stringify(opts.name)} not found — start it from a member repo with \`noir daemon start --workspace ${opts.name}\`.`,
      opts,
    );
  }
  const ensured = await ensureWorkspaceDaemonRunning({
    name: opts.name,
    project,
    idleTimeoutSec: project.config.workspace.idleTimeoutSec,
  });
  upsertWorkspaceMember(reg, { projectId: project.id, root: project.root, joinedAt: Date.now() });
  finishJoin(project, opts.name, opts);
  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { joined: true, url: ensured.url, port: ensured.port } })}\n`,
    );
    return;
  }
  info(`joined workspace ${JSON.stringify(opts.name)} (${ensured.url}).`, opts);
}

/** `noir workspace list` — every workspace on this machine + member count. */
export async function workspaceList(opts: CliOptions): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(workspaceHomeDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    names = [];
  }
  // Liveness is the daemon's own answer, never "the recorded pid is alive": a
  // daemon that crashed without cleanup leaves a record whose pid a recycled
  // process now holds, and trusting the pid alone would read that as running.
  // Each probe is single-shot and bounded (see the shared verify helper).
  const rows = await Promise.all(
    names.map(async (n) => {
      const reg = readWorkspaceRegistry(n);
      const rec = readWorkspaceDaemonRecord(n);
      const health = rec === null ? null : await verifyWorkspaceDaemon(rec, n);
      const running = health?.kind === 'healthy';
      return {
        name: n,
        members: reg?.members.length ?? 0,
        running,
        ...(rec !== null && !running ? { stale: true } : {}),
      };
    }),
  );
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { workspaces: rows } })}\n`);
    return;
  }
  if (rows.length === 0) {
    info('No workspaces yet.', opts);
    return;
  }
  for (const r of rows) {
    const state = r.running ? ', running' : r.stale ? ', not running (stale record)' : '';
    log(`${r.name} — ${r.members} member(s)${state}`, opts);
  }
}

/** `noir workspace status [name]` — members + daemon liveness. */
export async function workspaceStatus(opts: WorkspaceStatusOptions): Promise<void> {
  const name = opts.name ?? readWorkspaceMarker(process.cwd()) ?? undefined;
  if (name === undefined) {
    fail(EXIT.USAGE, 'workspace status requires a name (or run from a joined repo).', opts);
  }
  if (!isValidWorkspaceName(name)) {
    fail(EXIT.USAGE, `invalid workspace name ${JSON.stringify(name)}.`, opts);
  }
  const reg = readWorkspaceRegistry(name);
  const rec = readWorkspaceDaemonRecord(name);
  // Liveness is the daemon's own answer, never "the recorded pid is alive": a
  // recycled pid belongs to an unrelated process, so a record the probe cannot
  // confirm reads as not running and is reported stale.
  const health = rec === null ? null : await verifyWorkspaceDaemon(rec, name);
  const running = health?.kind === 'healthy';
  const data = {
    name,
    members: reg?.members.map((m) => m.projectId) ?? [],
    running,
    ...(rec ? { pid: rec.pid, port: rec.port } : {}),
    ...(rec !== null && !running ? { stale: true } : {}),
  };
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  const state = running
    ? `running (pid ${rec?.pid}, port ${rec?.port})`
    : rec !== null
      ? `not running (stale record for pid ${rec.pid})`
      : 'not running';
  log(`workspace ${name}: ${state}`, opts);
  for (const m of data.members) log(`  member: ${m}`, opts);
}

/** `noir workspace leave` — remove this repo from membership + restore stdio. */
export async function workspaceLeave(opts: WorkspaceLeaveOptions): Promise<void> {
  const project = loadProjectOrFail(opts);
  const name = readWorkspaceMarker(project.root);
  if (name === null) {
    fail(EXIT.USAGE, 'this repo is not joined to a workspace.', opts);
  }
  // Restore stdio FIRST — it is the one step that can fail (a non-Noir .mcp.json
  // is refused without `--force`). Doing it last would strand the repo mid-leave:
  // membership removed + marker cleared, but .mcp.json still pointed at a
  // workspace the repo no longer belongs to.
  writeStdioEntry(project.root, project.config.host, opts);
  const reg = readWorkspaceRegistry(name);
  if (reg && isWorkspaceMember(reg, project.id)) {
    removeWorkspaceMember(reg, project.id);
  }
  clearWorkspaceMarker(project.root);
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { left: name } })}\n`);
    return;
  }
  info(`left workspace ${JSON.stringify(name)}.`, opts);
}

/** `noir workspace stop [name]` — stop the workspace daemon (membership retained). */
export async function workspaceStop(opts: WorkspaceStatusOptions): Promise<void> {
  const name = opts.name ?? readWorkspaceMarker(process.cwd()) ?? undefined;
  if (name === undefined) {
    fail(EXIT.USAGE, 'workspace stop requires a name (or run from a joined repo).', opts);
  }
  if (!isValidWorkspaceName(name)) {
    fail(EXIT.USAGE, `invalid workspace name ${JSON.stringify(name)}.`, opts);
  }
  const rec = readWorkspaceDaemonRecord(name);
  if (rec === null || !pidAlive(rec.pid)) {
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { running: false, stopped: false } })}\n`,
      );
      return;
    }
    info('workspace daemon is not running.', opts);
    return;
  }
  // "The recorded pid is alive" is not proof it is this workspace's daemon: a
  // recycled pid belongs to an unrelated process, and signalling it would kill
  // that instead. Ask the recorded port to identify itself first.
  const health = await verifyWorkspaceDaemon(rec, name);
  if (health.kind !== 'healthy') {
    fail(EXIT.ERROR, stopRefusal(name, rec, health), opts);
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {
    // already exited between the probe and the signal
  }
  clearWorkspaceDaemonRecord(name);
  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { running: false, stopped: true, pid: rec.pid } })}\n`,
    );
    return;
  }
  info(`stopped workspace daemon (pid ${rec.pid}).`, opts);
}

/**
 * Why a record was not proven to belong to this workspace's daemon, so `stop`
 * must not signal it. A different workspace answering the recorded port is the
 * sharper diagnosis — it names which record is the stale one — so it is reported
 * on its own; any other failure to identify is the "silent" case.
 */
function stopRefusal(
  name: string,
  rec: { pid: number; port: number },
  health: Extract<WorkspaceDaemonHealth, { kind: 'silent' | 'foreign' }>,
): string {
  if (health.kind === 'foreign') {
    return (
      `refusing to stop workspace ${name}: the daemon answering on port ${rec.port} serves ` +
      `workspace ${health.workspace}, so the recorded pid ${rec.pid} is not this workspace's daemon.`
    );
  }
  return (
    `refusing to stop workspace ${name}: the process recorded for it (pid ${rec.pid}) does not ` +
    `answer /health as this workspace, so it may be an unrelated process.`
  );
}
