import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, paths, RULES_BLOCK } from '@noir-ai/core'; // CONTEXT_BLOCK_BEGIN re-exported below; see note
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-cli-'));
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** POSIX-only assertions: Windows permissions are ACL-based, so a mode there
 *  asserts something the platform cannot express. */
const posixIt = it.skipIf(process.platform === 'win32');

const envPath = (): string => join(paths.noirDir(root), '.env');

/** Run `init` with stderr captured, so a line the run prints can be pinned
 *  without the test reading the terminal. */
async function initCapturingStderr(): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => {
    chunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    await init(root, { transport: 'stdio' });
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

describe('init', () => {
  it('scaffolds .noir/ and root .mcp.json + CLAUDE.md', async () => {
    await init(root, { transport: 'stdio' });

    expect(existsSync(paths.noirMd(root))).toBe(true);
    expect(existsSync(paths.config(root))).toBe(true);
    expect(existsSync(paths.projectId(root))).toBe(true);

    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });

    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(CONTEXT_BLOCK_BEGIN);
    expect(claudeMd).toContain('@import ".noir/NOIR.md"');

    // Rules seed + rules @import managed block in CLAUDE.md (slice R).
    expect(existsSync(paths.rulesMd(root))).toBe(true);
    const rules = readFileSync(paths.rulesMd(root), 'utf8');
    expect(rules).toContain('Anti-assumption contract');
    expect(claudeMd).toContain(RULES_BLOCK.begin);
    expect(claudeMd).toContain('@import ".noir/rules/RULES.md"');

    // Ignore management (slice I): .gitignore managed block.
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('/.noir/store/');
  });

  it('scaffolds an http .mcp.json when transport is streamable-http', async () => {
    await init(root, { transport: 'streamable-http', url: 'http://127.0.0.1:4321/mcp' });
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });
});

// `.noir/.env` holds real credentials, so a run that finds it readable by group
// or others tightens it to 0600 and says so — a file fixed without a word is
// the silent drift this re-assert exists to end. The announcement has to be
// emitted BEFORE the already-initialized guard: a bare `noir init` on an
// existing project re-emits nothing, which is exactly the run that can find a
// stale mode, so a heal moved below the guard would go unannounced on the one
// path that most often performs it.
describe('init — the .noir/.env permission heal is announced', () => {
  posixIt(
    'announces the heal on an already-initialized project (before the no-op guard)',
    async () => {
      await init(root, { transport: 'stdio' });
      // The state an older Noir, or an editor that saves by rename, leaves behind.
      chmodSync(envPath(), 0o644);

      const stderr = await initCapturingStderr();

      expect(stderr).toContain('Tightened .noir/.env to 0600');
      // …and the run really did short-circuit on the no-op guard, so the line
      // above is the only place this run could have reported the heal from.
      expect(stderr).not.toContain('Noir initialized in');
    },
  );

  posixIt('prints no heal line when the file is already owner-only', async () => {
    await init(root, { transport: 'stdio' });

    const stderr = await initCapturingStderr();

    // Only a real heal is worth a line: a run that changed nothing says nothing.
    expect(stderr).not.toContain('Tightened');
  });
});
