// `noir workspace *` + the `--workspace` branch of `noir daemon start` + `noir daemon join`.
//
// A workspace is a named cross-repo sharing unit. `daemon start --workspace <name>`
// founds/joins it from the current repo and starts the detached workspace daemon;
// `daemon join <name>` joins it from another repo. `workspace list/status/leave/stop`
// manage membership. Joining writes a `.noir/workspace.json` marker + rewrites the
// repo's `.mcp.json` `noir` entry to the workspace daemon URL (`?p=<projectId>`);
// leaving reverses both. Default transport (stdio) and project behavior are
// untouched unless a repo explicitly joins.
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
import { writeStdioEntry, writeWorkspaceHttpEntry } from '../workspace-mcp.js';

export interface WorkspaceStartOptions extends CliOptions {
  name: string;
  detach?: boolean;
  detachChild?: boolean;
}
export interface WorkspaceJoinOptions extends CliOptions {
  name: string;
  force?: boolean;
}
export interface WorkspaceStatusOptions extends CliOptions {
  name?: string;
}

function loadProjectOrFail(opts: CliOptions): ProjectInfo {
  try {
    return loadProjectInfo(process.cwd());
  } catch {
    fail(EXIT.ERROR, 'Noir is not initialized in this directory. Run `noir init` first.', opts);
  }
}

function finishJoin(
  project: ProjectInfo,
  name: string,
  url: string,
  opts: CliOptions & { force?: boolean },
): void {
  writeWorkspaceMarker(project.root, name);
  writeWorkspaceHttpEntry(project.root, project.config.host, url, project.id, opts);
}

/** `noir daemon start --workspace <name>` — found a workspace + start its daemon. */
export async function daemonStartWorkspace(opts: WorkspaceStartOptions): Promise<void> {
  const project = loadProjectOrFail(opts);
  if (!isValidWorkspaceName(opts.name)) {
    fail(
      EXIT.USAGE,
      `invalid workspace name ${JSON.stringify(opts.name)} (letters, digits, and dashes).`,
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
      idleTimeoutSec: 0,
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
    finishJoin(project, opts.name, `http://127.0.0.1:${spawned.port}/mcp`, opts);
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
    idleTimeoutSec: 0,
  });
  finishJoin(project, opts.name, ensured.url, opts);
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
    idleTimeoutSec: 0,
  });
  upsertWorkspaceMember(reg, { projectId: project.id, root: project.root, joinedAt: Date.now() });
  finishJoin(project, opts.name, ensured.url, opts);
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
  const rows = names.map((n) => {
    const reg = readWorkspaceRegistry(n);
    return {
      name: n,
      members: reg?.members.length ?? 0,
      running: readWorkspaceDaemonRecord(n) !== null,
    };
  });
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { workspaces: rows } })}\n`);
    return;
  }
  if (rows.length === 0) {
    info('No workspaces yet.', opts);
    return;
  }
  for (const r of rows) {
    log(`${r.name} — ${r.members} member(s)${r.running ? ', running' : ''}`, opts);
  }
}

/** `noir workspace status [name]` — members + daemon liveness. */
export async function workspaceStatus(opts: WorkspaceStatusOptions): Promise<void> {
  const name = opts.name ?? readWorkspaceMarker(process.cwd()) ?? undefined;
  if (name === undefined) {
    fail(EXIT.USAGE, 'workspace status requires a name (or run from a joined repo).', opts);
  }
  const reg = readWorkspaceRegistry(name);
  const rec = readWorkspaceDaemonRecord(name);
  const running = rec !== null && pidAlive(rec.pid);
  const data = {
    name,
    members: reg?.members.map((m) => m.projectId) ?? [],
    running,
    ...(rec ? { pid: rec.pid, port: rec.port } : {}),
  };
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  log(
    `workspace ${name}: ${running ? `running (pid ${rec?.pid}, port ${rec?.port})` : 'not running'}`,
    opts,
  );
  for (const m of data.members) log(`  member: ${m}`, opts);
}

/** `noir workspace leave` — remove this repo from membership + restore stdio. */
export async function workspaceLeave(opts: CliOptions): Promise<void> {
  const project = loadProjectOrFail(opts);
  const name = readWorkspaceMarker(project.root);
  if (name === null) {
    fail(EXIT.USAGE, 'this repo is not joined to a workspace.', opts);
  }
  const reg = readWorkspaceRegistry(name);
  if (reg && isWorkspaceMember(reg, project.id)) {
    removeWorkspaceMember(reg, project.id);
  }
  clearWorkspaceMarker(project.root);
  writeStdioEntry(project.root, project.config.host, opts);
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
