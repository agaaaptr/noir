// The skill pack's report must match what actually landed on disk.
//
// A non-interactive run resolves a differing skill file to `preserve` — the
// right default for a pipe, but one that used to be invisible: the run counted
// every skill it LOOKED at and printed "Emitted N", so a CI upgrade could keep
// stale skill bodies for several versions while reporting success. These tests
// drive the REAL bin program (`createProgram().parseAsync`) against a temp dir
// and pin both halves of the honest report: the stderr line naming the stale
// skills, and the `--json` payload carrying the records.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram, EXIT, inferExitCode } from '../src/bin.js';

let root: string;
let origCwd: string;

const SKILL_REL = join('.claude', 'skills', 'noir-brainstorming', 'SKILL.md');
/** What a user's hand-edited copy looks like: different bytes, same path. */
const USER_EDIT =
  '---\nname: noir-brainstorming\ndescription: Use when brainstorming.\n---\nMINE\n';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'noir-skills-report-')));
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
 *  (mirrors scaffold-dryrun.test.ts so commander errors map onto the S9
 *  contract and the `{ok,data}` envelope is read off stdout verbatim). */
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

/** The `{ok, data}` envelope the bin writes to stdout. */
function envelopeOf(stdout: string): {
  ok: boolean;
  data: {
    skillConflicts?: Array<{ path: string; resolution: string }>;
    preservedSkills?: string[];
  };
} {
  const last = stdout.trim().split('\n').pop();
  if (typeof last !== 'string' || last.length === 0) {
    throw new Error('no stdout envelope emitted');
  }
  return JSON.parse(last);
}

describe('skill emit reports what it wrote, not what it attempted', () => {
  // `noir init --upgrade` in a pipe (CI, `--json`, no TTY) resolves a differing
  // skill file to `preserve`. The run must say so instead of reporting the
  // stale skill as refreshed.
  it('names the preserved skills on stderr and counts only what was written', async () => {
    await parse(['init']);
    writeFileSync(join(root, SKILL_REL), USER_EDIT, 'utf8');

    const r = await parse(['init', '--upgrade', '--json']);

    expect(r.exitCode).toBe(EXIT.OK);
    // The written count reflects reality: the edited skill was not refreshed.
    expect(r.stderr).toMatch(/Emitted 26 Noir skills to \.claude\/skills\/ \(target: claude\)\./);
    // …and the stale one is named, with the one way to change the outcome.
    expect(r.stderr).toMatch(
      /1 skill\(s\) preserved as stale \(interactive TTY required to refresh\): noir-brainstorming/,
    );
    // The user's bytes survived — the report matches the disk.
    expect(readFileSync(join(root, SKILL_REL), 'utf8')).toBe(USER_EDIT);
  });

  it('carries the skill conflicts + preserved names in the --json envelope', async () => {
    await parse(['init']);
    writeFileSync(join(root, SKILL_REL), USER_EDIT, 'utf8');

    const r = await parse(['init', '--upgrade', '--json']);

    const envelope = envelopeOf(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.preservedSkills).toEqual(['noir-brainstorming']);
    expect(envelope.data.skillConflicts).toEqual([
      expect.objectContaining({
        path: 'noir-brainstorming/SKILL.md',
        mode: 'skill',
        resolution: 'preserve',
      }),
    ]);
    // Additive: the scaffold result's own keys are untouched.
    expect(envelope.data).toHaveProperty('written');
    expect(envelope.data).toHaveProperty('conflicts');
  });

  // The all-written path is unchanged: same count, no extra line, and empty
  // (not absent) structured fields so a consumer needs no existence check.
  it('says nothing about staleness when every skill was written', async () => {
    const r = await parse(['init', '--json']);

    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stderr).toMatch(/Emitted 27 Noir skills to \.claude\/skills\/ \(target: claude\)\./);
    expect(r.stderr).not.toContain('preserved as stale');

    const envelope = envelopeOf(r.stdout);
    expect(envelope.data.preservedSkills).toEqual([]);
    expect(envelope.data.skillConflicts).toEqual([]);
  });
});
