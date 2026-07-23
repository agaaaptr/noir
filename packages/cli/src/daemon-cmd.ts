import { loadProjectInfo } from '@noir-ai/core';
import { clearDaemonRecord, ensureDaemonRunning, readDaemonRecord } from '@noir-ai/daemon';

export async function daemonStart(): Promise<void> {
  const project = loadProjectInfo(process.cwd());
  const { url, started } = await ensureDaemonRunning({
    project,
    idleTimeoutSec: project.config.daemon.idleTimeoutSec,
  });
  process.stderr.write(`${started ? 'Started' : 'Reused'} Noir daemon at ${url}\n`);
  // When `started`, the in-process http server + idle timer keep this CLI process
  // alive, so `noir daemon start` runs a foreground daemon until idle-stop or
  // SIGINT/SIGTERM (handled inside startHttpServer). When `started` is false a
  // daemon is already running elsewhere; this process exits after reporting.
  // Detached/socket-activated spawning is a future refinement — blueprint D7.
}

export async function daemonStop(): Promise<void> {
  const rec = readDaemonRecord();
  if (!rec) {
    process.stderr.write('No Noir daemon is running.\n');
    return;
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
    process.stderr.write(`Stopped Noir daemon (pid ${rec.pid}).\n`);
  } catch (err) {
    // Process may have already exited; report but still clear the record below.
    process.stderr.write(
      `Noir daemon (pid ${rec.pid}) could not be signalled: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    clearDaemonRecord();
  }
}
