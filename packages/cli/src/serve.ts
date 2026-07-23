import { loadProjectInfo } from '@noir-ai/core';
import { startStdioServer } from '@noir-ai/daemon';

export async function serve(opts: { stdio: boolean }): Promise<void> {
  const project = loadProjectInfo(process.cwd());
  if (opts.stdio) {
    await startStdioServer({ project, transport: 'stdio', daemon: false });
    return; // stdio server runs until stdin closes
  }
  // Daemon-prefer path arrives in Task 10. Until then, default to stdio.
  process.stderr.write('Daemon transport not implemented yet; falling back to stdio.\n');
  await startStdioServer({ project, transport: 'stdio', daemon: false });
}
