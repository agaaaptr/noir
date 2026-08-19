import { applyNoirEnv, loadProjectInfo } from '@noir-ai/core';
import { ensureDaemonRunning, startStdioServer } from '@noir-ai/daemon';

export async function serve(opts: { stdio: boolean }): Promise<void> {
  // Load .noir/.env before constructing the MCP server so integration tokens
  // (e.g. CLICKUP_API_TOKEN) are resolvable at call time even when the daemon
  // was launched from a context that did not inherit the shell rc.
  applyNoirEnv(process.cwd());
  const project = loadProjectInfo(process.cwd());
  if (opts.stdio) {
    await startStdioServer({ project, transport: 'stdio', daemon: false });
    return; // stdio server runs until stdin closes
  }
  // Prefer the shared daemon; on failure fall back to in-process stdio so Noir
  // keeps working even when the daemon cannot start (FS-degradation path).
  try {
    const { url } = await ensureDaemonRunning({
      project,
      idleTimeoutSec: project.config.daemon.idleTimeoutSec,
    });
    process.stderr.write(
      `Noir daemon available at ${url}. (For HTTP clients, use this URL in .mcp.json.)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `Noir daemon unavailable (${err instanceof Error ? err.message : String(err)}); falling back to stdio.\n`,
    );
    await startStdioServer({ project, transport: 'stdio', daemon: false });
  }
}
