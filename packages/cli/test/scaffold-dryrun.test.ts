// F1 — scaffold engine dryRun surfaced onto the CLI (`--dry-run` / `--preview`).
//
// Drives the REAL bin program (`createProgram().parseAsync`) against a fresh
// temp dir and asserts the scaffold engine's existing dryRun support is exposed
// as init/create/sync flags: `noir init --dry-run` reports the PLANNED writes
// to stderr WITHOUT writing a single file (fs check on the target dir), and
// `--preview` is an alias that behaves identically. Under `--json` the planned
// list is emitted as the `{ok, data}` envelope on stdout instead.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram, EXIT, inferExitCode } from '../src/bin.js';

let root: string;
let origCwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'noir-dryrun-')));
  origCwd = process.cwd();
  process.chdir(root);
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

interface ParseResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Drive a fresh program with user-form args; capture exit code + streams
 *  (mirrors bin.test.ts's helper so commander errors map onto the S9 contract). */
async function parse(args: string[]): Promise<ParseResult> {
  const program = createProgram();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number = EXIT.OK;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    exitCode = inferExitCode(err);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { exitCode, stdout: outChunks.join(''), stderr: errChunks.join('') };
}

describe('noir init --dry-run (F1 dryRun surfacing)', () => {
  it('reports planned writes to stderr WITHOUT writing any files', async () => {
    const r = await parse(['init', '--dry-run']);

    expect(r.exitCode).toBe(EXIT.OK);
    // Human diagnostics → stderr; nothing on stdout (no --json envelope).
    expect(r.stdout).toBe('');
    // The planned-write summary names the artifacts a real init would emit.
    expect(r.stderr).toContain('Dry run');
    expect(r.stderr).toContain('.mcp.json');
    expect(r.stderr).toContain('.noir/NOIR.md');
    expect(r.stderr).toContain('.noir/project.id');
    expect(r.stderr).toContain('CLAUDE.md');

    // No files were written — the target dir is still empty.
    expect(readdirSync(root)).toEqual([]);
    // Explicit negative: no .noir/ store, no root pointer, no skill dir.
    for (const rel of ['.noir', '.mcp.json', 'CLAUDE.md', '.gitignore', '.claude']) {
      expect(existsSync(join(root, rel))).toBe(false);
    }
  });

  it('--preview is an alias for --dry-run (identical behavior)', async () => {
    const r = await parse(['init', '--preview']);

    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Dry run');
    expect(r.stderr).toContain('.mcp.json');
    expect(r.stderr).toContain('.noir/NOIR.md');
    expect(readdirSync(root)).toEqual([]);
  });

  it('--json emits the planned list as the data envelope on stdout (no writes)', async () => {
    const r = await parse(['init', '--dry-run', '--json']);

    expect(r.exitCode).toBe(EXIT.OK);
    const last = r.stdout.trim().split('\n').pop();
    if (typeof last !== 'string' || last.length === 0) {
      throw new Error('no stdout envelope emitted');
    }
    const envelope = JSON.parse(last) as { ok: boolean; data: { written: string[] } };
    expect(envelope.ok).toBe(true);
    // The ScaffoldResult under dryRun carries the PLANNED paths.
    expect(envelope.data.written).toContain('.mcp.json');
    expect(envelope.data.written).toContain('.noir/NOIR.md');
    // Still zero writes on disk.
    expect(readdirSync(root)).toEqual([]);
  });
});
