// S10 — multi-host CLI tests.
//
// Drives the REAL `init`/`create`/`sync` (no mocks) end-to-end through the
// resolved adapter for each `--host <id>`. Asserts the host's primary
// artifacts land on disk + that the chosen host persists to `.noir/config.yml`
// (so a subsequent bare `noir sync` re-emits the SAME host without --host).
// The claude default is asserted byte-identical to v1.1 (fix-wave I1 REMOVED
// the additive root AGENTS.md — it double-imported .noir/ via CLAUDE.md).
//
// The bin-level `--host` argv wiring is covered in bin.test.ts; this file
// covers the module-level behavior the bin dispatches to.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '../src/commands/create.js';
import { init } from '../src/init.js';
import { sync } from '../src/sync.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-multi-host-'));
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('noir init --host <id> — per-host artifact matrix', () => {
  it('claude (default): CLAUDE.md + .mcp.json + .claude/skills (SKILL.md); NO AGENTS.md (I1)', async () => {
    await init(root, { transport: 'stdio' });

    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    // I1 regression anchor: claude NO LONGER emits AGENTS.md (would double-
    // import .noir/ via CLAUDE.md's existing @-imports). The default `noir init`
    // is now BYTE-IDENTICAL to v1.1.
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, '.claude', 'skills'))).toBe(true);
    // A skill file is the verbatim SKILL.md shape (claude CompileTarget).
    expect(existsSync(join(root, '.claude', 'skills', 'noir-brainstorm', 'SKILL.md'))).toBe(true);
    // config.yml persisted host: claude (the default).
    expect(readFileSync(paths.config(root), 'utf8')).toMatch(/^host: claude/m);
  });

  it('gemini: GEMINI.md + .gemini/mcp.json; NO AGENTS.md (I1); no .claude/; no skills dir', async () => {
    await init(root, { transport: 'stdio', host: 'gemini' });

    expect(existsSync(join(root, 'GEMINI.md'))).toBe(true);
    // I1: gemini NO LONGER emits AGENTS.md.
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, '.gemini', 'mcp.json'))).toBe(true);
    // Gemini has no skill concept — no .claude/skills, no .gemini/skills.
    expect(existsSync(join(root, '.claude'))).toBe(false);
    // Claude artifacts do NOT leak.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    // config.yml persisted host: gemini.
    expect(readFileSync(paths.config(root), 'utf8')).toMatch(/^host: gemini/m);
  });

  it('cursor: AGENTS.md + .cursor/mcp.json + skills as FLAT .mdc; rules via AGENTS.md (no host-rules .mdc)', async () => {
    await init(root, { transport: 'stdio', host: 'cursor' });

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    // No separate host-rules .mdc — the prior `noir-contract.mdc` pointer was
    // REMOVED (it collided with the cursor flat-skill prune of `noir-*.mdc`
    // under .cursor/rules/). Cursor's rules ride AGENTS.md's
    // `@.noir/rules/RULES.md` import instead (same universal surface as
    // agents-md/opencode). The `noir-rules` builtin skill now legitimately
    // lands at `noir-rules.mdc` (a real skill, FLAT) — no host-rules pointer
    // collides with it anymore.
    expect(existsSync(join(root, '.cursor', 'rules', 'noir-rules.mdc'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
    // Cursor skills land FLAT under .cursor/rules/ (one .mdc per skill, no
    // per-name subdir — Cursor's rule loader does not recurse).
    expect(existsSync(join(root, '.cursor', 'rules', 'noir-brainstorm.mdc'))).toBe(true);
    // The prior nested layout is GONE.
    expect(
      existsSync(join(root, '.cursor', 'rules', 'noir-brainstorm', 'noir-brainstorm.mdc')),
    ).toBe(false);
    // No CLAUDE.md / GEMINI.md leakage.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
    // config.yml persisted host: cursor.
    expect(readFileSync(paths.config(root), 'utf8')).toMatch(/^host: cursor/m);
  });

  it('opencode: AGENTS.md + opencode.json; no skills dir', async () => {
    await init(root, { transport: 'stdio', host: 'opencode' });

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, 'opencode.json'))).toBe(true);
    // No skills emission for opencode.
    expect(existsSync(join(root, '.claude'))).toBe(false);
    // opencode.json carries the $schema + type-tagged mcp block.
    const cfg = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.mcp.noir).toEqual({ type: 'local', command: ['noir', 'mcp', 'serve', '--stdio'] });
  });

  it('agents-md: AGENTS.md + .mcp.json; no host-native context beyond AGENTS.md', async () => {
    await init(root, { transport: 'stdio', host: 'agents-md' });

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
  });
});

describe('noir create --host <id> — greenfield per host', () => {
  it('create --host gemini bootstraps a fresh dir with GEMINI.md + .gemini/mcp.json (NO AGENTS.md — I1)', async () => {
    const target = join(root, 'fresh-gemini');
    expect(existsSync(target)).toBe(false);

    await create(target, { transport: 'stdio', host: 'gemini' });

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, 'GEMINI.md'))).toBe(true);
    // I1: gemini NO LONGER emits AGENTS.md.
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(target, '.gemini', 'mcp.json'))).toBe(true);
    expect(existsSync(join(target, '.noir', 'project.id'))).toBe(true);
  });

  it('create --host cursor bootstraps AGENTS.md + .cursor/mcp.json + skills as FLAT .mdc', async () => {
    const target = join(root, 'fresh-cursor');
    await create(target, { transport: 'stdio', host: 'cursor' });

    // Cursor's rules ride AGENTS.md's @-import (no separate host-rules .mdc).
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(target, '.cursor', 'mcp.json'))).toBe(true);
    // Skills land FLAT under .cursor/rules/<skill>.mdc (no nested dir).
    expect(existsSync(join(target, '.cursor', 'rules', 'noir-brainstorm.mdc'))).toBe(true);
    expect(
      existsSync(join(target, '.cursor', 'rules', 'noir-brainstorm', 'noir-brainstorm.mdc')),
    ).toBe(false);
  });
});

describe('noir sync — host round-trips from .noir/config.yml', () => {
  it('init --host gemini then bare sync re-emits GEMINI.md (host read from config)', async () => {
    await init(root, { transport: 'stdio', host: 'gemini' });
    // Wipe GEMINI.md to USER-ONLY content (no managed regions) so the bare sync
    // must RE-EMIT both regions. (Merge is now the default — a stale IN-REGION
    // edit would be PRESERVED by the merge, so removing the regions entirely is
    // the merge-default-compatible way to prove sync re-emits them. A missing
    // region is always re-added fresh.)
    writeFileSync(join(root, 'GEMINI.md'), '# My gemini notes\n', 'utf8');

    await sync(root); // no --host → reads config.host

    const md = readFileSync(join(root, 'GEMINI.md'), 'utf8');
    // Both managed regions were re-emitted with the current @-import bodies.
    expect(md).toContain('<!-- noir:context begin -->');
    expect(md).toContain('@.noir/NOIR.md');
    // User content OUTSIDE the markers survives sync.
    expect(md).toContain('# My gemini notes');
    // Host was read from config (gemini), not the default claude — proven by
    // GEMINI.md being touched at all (a claude sync would not write GEMINI.md).
    expect(md).toContain('<!-- noir:rules begin -->');
  });

  it('sync --host override re-emits under the override (advanced)', async () => {
    // Project initialized under claude.
    await init(root, { transport: 'stdio' });
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);

    // Override-emt under cursor — adds cursor artifacts alongside.
    await sync(root, { host: 'cursor' });
    // Cursor's rules ride AGENTS.md's @-import (no separate host-rules .mdc).
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
  });
});

describe('noir init — claude byte-identity (regression anchor)', () => {
  // Fix-wave I1 restored the byte-identity guarantee: the default `noir init` is
  // now FULLY byte-equivalent to v1.1 (the additive root AGENTS.md was REMOVED
  // — claude's CLAUDE.md already @-imports .noir/ sources, so AGENTS.md
  // double-imported them). The scaffold.test.ts parity gates assert .mcp.json +
  // CLAUDE.md regions byte-equal the adapter; here we add the no-AGENTS.md
  // regression anchor + confirm the v1.1 files are still byte-stable.
  it('default init produces .mcp.json + CLAUDE.md + ignores; NO AGENTS.md (I1 = full v1.1 byte-identity)', async () => {
    await init(root, { transport: 'stdio' });
    // I1 regression anchor: claude does NOT emit AGENTS.md (would double-import
    // .noir/ via CLAUDE.md's existing @-imports). The default `noir init` is
    // byte-identical to v1.1.
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    // v1.1 regression-anchor files unchanged.
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
    // The .mcp.json is the {mcpServers} shape, stdio entry.
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });

  it('claude default-then-sync is byte-idempotent for .mcp.json + CLAUDE.md', async () => {
    await init(root, { transport: 'stdio' });
    const mcpAfter1 = readFileSync(join(root, '.mcp.json'), 'utf8');
    const claudeAfter1 = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

    await sync(root);

    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(mcpAfter1);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(claudeAfter1);
    // I1: AGENTS.md still absent after sync (no double-emission on re-run).
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });
});
