// `noir sync` — re-emit the runtime subset of the scaffold manifest.
//
// Slice S-T2 refactor: delegates to `@noir-ai/create`'s `scaffold({mode:'sync'})`,
// which emits ONLY the regenerate + managedBlock entries (the always-safe-to-
// rewrite subset). Per the S-T2 contract notes, this ADOPTS THE ENGINE'S
// SEMANTICS and retires the predecessor's ad-hoc behavior:
//
//   - The engine re-emits `.mcp.json` (regenerate) + NOIR.md brief
//     (managedBlock) + CLAUDE.md context/rules blocks + ignore-file blocks.
//     The predecessor's sync re-emitted only CLAUDE.md blocks + ignores and
//     did NOT refresh `.mcp.json`/NOIR.md — the engine is a strict superset
//     here, so a transport/url change is now picked up by `noir sync`.
//   - The engine does NOT seed `.noir/rules/RULES.md` on sync (RULES.md is
//     skipIfExists, owned by init/create). The predecessor seeded it when
//     missing; init now owns all seeds. (Spec-aligned: "sync re-emits
//     generated/managed content; init owns seeds.")
//
// Skills emission stays a core sync feature — composed after scaffold().
// `scaffold({mode:'sync'})` throws when the project isn't initialized
// (no .noir/project.id), matching the predecessor's `loadProjectInfo` gate.

import { claudeAdapter } from '@noir-ai/adapters';
import { scaffold } from '@noir-ai/create';
import { emitSkillsToDir } from '@noir-ai/skills';

export async function sync(root: string): Promise<void> {
  await scaffold({ root, mode: 'sync' });

  if (!claudeAdapter.skillsDir) {
    process.stderr.write('This host has no skill emitter; nothing to sync.\n');
    return;
  }
  const summary = await emitSkillsToDir(claudeAdapter.skillsDir({ root }));
  process.stderr.write(`Synced ${summary.emitted.length} Noir skills to .claude/skills/.\n`);
}
