import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeAdapter } from '@noir-ai/adapters';
import {
  CONTEXT_BLOCK,
  loadProjectInfo,
  paths,
  RULES_BLOCK,
  writeManagedRegion,
} from '@noir-ai/core';
import { emitSkillsToDir } from '@noir-ai/skills';
import { RULES_SEED } from './rules-seed.js';

export async function sync(root: string): Promise<void> {
  loadProjectInfo(root); // asserts Noir is initialized (throws otherwise)

  // Reconcile host context-file managed blocks (context + rules).
  writeManagedRegion(join(root, 'CLAUDE.md'), CONTEXT_BLOCK, claudeAdapter.emitContext({ root }));
  if (claudeAdapter.emitRules) {
    writeManagedRegion(join(root, 'CLAUDE.md'), RULES_BLOCK, claudeAdapter.emitRules({ root }));
  }

  // Seed .noir/rules/RULES.md if missing (skip_if_exists: never clobber user edits).
  if (!existsSync(paths.rulesMd(root))) {
    mkdirSync(dirname(paths.rulesMd(root)), { recursive: true });
    writeFileSync(paths.rulesMd(root), RULES_SEED, 'utf8');
  }

  if (!claudeAdapter.skillsDir) {
    process.stderr.write('This host has no skill emitter; nothing to sync.\n');
    return;
  }
  const summary = await emitSkillsToDir(claudeAdapter.skillsDir({ root }));
  process.stderr.write(`Synced ${summary.emitted.length} Noir skills to .claude/skills/.\n`);
}
