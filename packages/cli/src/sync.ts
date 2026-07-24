import { claudeAdapter } from '@noir-ai/adapters';
import { loadProjectInfo } from '@noir-ai/core';
import { emitSkillsToDir } from '@noir-ai/skills';

export async function sync(root: string): Promise<void> {
  loadProjectInfo(root); // asserts Noir is initialized (throws otherwise)
  if (!claudeAdapter.skillsDir) {
    process.stderr.write('This host has no skill emitter; nothing to sync.\n');
    return;
  }
  const summary = await emitSkillsToDir(claudeAdapter.skillsDir({ root }));
  process.stderr.write(`Synced ${summary.emitted.length} Noir skills to .claude/skills/.\n`);
}
