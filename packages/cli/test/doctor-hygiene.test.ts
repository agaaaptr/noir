// `noir doctor` — the two-tier output-hygiene check.
//
// The check runs the @noir-ai/skills hygiene rules over the repository's own
// source and documents. A fail-tier pattern (a divider drawn in punctuation,
// numbered narration, a decorative emoji, a forbidden residue token) makes the
// check fail; a warn-tier pattern (a long comment block, a bare TODO) makes it
// warn; a clean tree passes; and the detail names the file and line of each
// finding, capped at HYGIENE_FINDING_CAP with a count of the rest.
//
// Every fixture lives in a temporary directory. The repository this check ships
// in carries findings of its own (the sweep that removes them runs after this
// task), so a test that asserted against the real tree would fail for reasons
// unrelated to the check. The scan scope is exercised per-fixture instead.
//
// Offline and free: reads files, no network, no key.
//
// The fixtures are assembled rather than written out so this file does not
// itself carry a banner, a decorative emoji or numbered narration. The residue
// fixtures are the exception: they name the forbidden tokens on purpose, to
// assert that those tokens still fire, so this file carries the exemption
// marker the rules honour.
// noir-hygiene: exempt
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_COMMENT_BLOCK_LINES } from '@noir-ai/skills';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CheckResult,
  checkOutputHygiene,
  doctor,
  HYGIENE_FINDING_CAP,
  HYGIENE_MAX_FILE_BYTES,
  HYGIENE_MAX_FILES,
} from '../src/commands/doctor.js';

/** A divider drawn in punctuation around `label` — a fail-tier banner. */
const banner = (label: string): string => `// ${'='.repeat(10)} ${label} ${'='.repeat(10)}\n`;

/** A heading that opens with a decorative emoji — a fail-tier document pattern. */
const emojiHeading = (): string => `# ${String.fromCodePoint(0x1f389)} Release notes\n`;

/** A forbidden residue token, on a line of its own. */
const residue = (token: string): string => `${token}\n`;

/** A run of comment lines long enough to be narration — a warn-tier pattern. */
const longCommentBlock = (): string =>
  Array.from({ length: MAX_COMMENT_BLOCK_LINES }, (_, i) => `// filler line ${i + 1}`).join('\n') +
  '\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-doctor-hygiene-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a fixture file, creating its parent directories. */
function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** Run the check against the fixture root and return its row and totals. */
function run(): { row: CheckResult; fail: number; warn: number } {
  const checks: CheckResult[] = [];
  const result = checkOutputHygiene(checks, root);
  const row = checks.find((c) => c.name === 'output hygiene');
  if (!row) throw new Error("the check pushed no 'output hygiene' row");
  return { row, fail: result.fail, warn: result.warn };
}

describe('checkOutputHygiene', () => {
  it('reports a failing check naming the file and line for a fail-tier code pattern', () => {
    write('packages/a/src/load.ts', `${banner('load')}export const a = 1;\n`);
    const { row, fail } = run();
    expect(row.status).toBe('fail');
    expect(fail).toBe(1);
    expect(row.detail).toContain('packages/a/src/load.ts:1');
    expect(row.detail).toContain('decorative-banner');
  });

  it('reports a failing check for a fail-tier pattern in a document', () => {
    write('packages/a/src/clean.ts', 'export const a = 1;\n');
    write('README.md', `${emojiHeading()}A change log.\n`);
    const { row } = run();
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('README.md:1');
    expect(row.detail).toContain('decorative-emoji-doc');
  });

  it('scans nothing and passes when the repository has none of the layout the check is for', () => {
    // The everyday case: an application repository that is a README and little
    // else. Its prose is not what these rules judge, so the check reads nothing.
    write('README.md', `${emojiHeading()}A change log.\n`);
    const { row, fail, warn } = run();
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/nothing to scan/);
    expect(fail).toBe(0);
    expect(warn).toBe(0);
  });

  it('skips dot-files, which are tool configuration rather than repository source', () => {
    write('scripts/build.sh', 'echo build\n');
    write('.eslintrc.cjs', `${banner('rules')}module.exports = {};\n`);
    const { row } = run();
    expect(row.status).toBe('ok');
  });

  it('skips files over the size cap and says so', () => {
    write('scripts/build.sh', 'echo build\n');
    write(
      'scripts/huge.ts',
      `${banner('huge')}${'x'.repeat(HYGIENE_MAX_FILE_BYTES)}\nexport const big = 1;\n`,
    );
    const { row, fail } = run();
    expect(fail).toBe(0);
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('1 file over');
    expect(row.detail).toContain('skipped');
  });

  it('stops at the file cap and says the scan was truncated', () => {
    mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
    // One more file than the cap, every one of them a finding, so the row is
    // the same whichever file the cap drops.
    for (let i = 0; i <= HYGIENE_MAX_FILES; i++) {
      writeFileSync(join(root, 'packages', 'a', 'src', `f-${i}.ts`), banner(`f${i}`));
    }
    const { row } = run();
    expect(row.status).toBe('fail');
    expect(row.detail).toContain(`stopped at ${HYGIENE_MAX_FILES} files`);
  });

  it('reports a failing check for a forbidden residue token', () => {
    write('packages/a/src/config.ts', residue('noir-workflow'));
    const { row } = run();
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('packages/a/src/config.ts:1');
  });

  it('reports a warning, not a failure, for a warn-tier pattern', () => {
    write('packages/a/src/notes.ts', `${longCommentBlock()}export const b = 2;\n`);
    const { row, fail, warn } = run();
    expect(row.status).toBe('warn');
    expect(fail).toBe(0);
    expect(warn).toBe(1);
    expect(row.detail).toContain('long-comment-block');
  });

  it('reports an ok row for a clean repository', () => {
    write('packages/a/src/clean.ts', '// A note about why this exists.\nexport const c = 3;\n');
    write('docs/guide.md', '# Guide\n\nA reader-facing page.\n');
    const { row } = run();
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/clean/);
  });

  it('passes a file that carries the exemption marker, while a sibling is still reported', () => {
    write('packages/a/src/exempt.ts', `// noir-hygiene: exempt\n${residue('noir-workflow')}`);
    write('packages/a/src/plain.ts', residue('noir-workflow'));
    const { row } = run();
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('packages/a/src/plain.ts:1');
    expect(row.detail).not.toContain('packages/a/src/exempt.ts');
  });

  it('does not scan the planning corpus', () => {
    write('docs/internal/plan.md', `${emojiHeading()}planning shorthand\n`);
    write('docs/decisions/ADR-0001.md', `${banner('adr')}decided\n`);
    write('docs/roadmap/backlog.md', `${emojiHeading()}backlog\n`);
    write('CHANGELOG.md', `${banner('release')}release notes\n`);
    write('docs/CHANGELOG.md', `${emojiHeading()}pointer\n`);
    const { row } = run();
    expect(row.status).toBe('ok');
  });

  it('scans documents under docs/ that are outside the planning corpus', () => {
    write('docs/guides/hygiene.md', `${emojiHeading()}guidance\n`);
    const { row } = run();
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('docs/guides/hygiene.md:1');
  });

  it('scans test trees and the scripts directory', () => {
    write('packages/a/test/a.test.ts', banner('test'));
    write('scripts/build.sh', `# ${'='.repeat(8)} build ${'='.repeat(8)}\n`);
    const { row } = run();
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('packages/a/test/a.test.ts:1');
    expect(row.detail).toContain('scripts/build.sh:1');
  });

  it('caps the reported findings and says how many it left out', () => {
    for (let i = 1; i <= HYGIENE_FINDING_CAP + 2; i++) {
      write(`packages/a/src/file-${i}.ts`, banner(`file ${i}`));
    }
    const { row, fail } = run();
    expect(row.status).toBe('fail');
    expect(fail).toBe(HYGIENE_FINDING_CAP + 2);
    expect(row.detail).toContain('(+2 more)');
    expect(row.detail).toContain('file-1.ts');
    expect(row.detail).not.toContain('file-7.ts');
  });

  it('skips files whose format the rules cannot read', () => {
    write('packages/a/src/data.json', residue('noir-workflow'));
    write('scripts/notes.env', residue('noir-workflow'));
    const { row } = run();
    expect(row.status).toBe('ok');
  });
});

interface DoctorData {
  checks: Array<{ name: string; status: string; detail: string }>;
}

/** Run `noir doctor --json` against the fixture root and return its data. The
 *  command throws (exit-code signal) when a critical check fails; the JSON was
 *  already written to stdout, which is all these assertions need. */
async function runDoctor(): Promise<DoctorData> {
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.chdir(root);
  try {
    await doctor({ json: true });
  } catch {
    // expected on a fail — the payload was captured before the throw
  } finally {
    process.chdir(origCwd);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const envelope = JSON.parse(out.join('')) as { ok: boolean; data: DoctorData };
  return envelope.data;
}

describe('noir doctor — the output-hygiene check is registered', () => {
  it('emits a failing output-hygiene row when the repository carries a fail-tier pattern', async () => {
    write('packages/a/src/load.ts', `${banner('load')}export const a = 1;\n`);
    const data = await runDoctor();
    const row = data.checks.find((c) => c.name === 'output hygiene');
    expect(row).toBeDefined();
    expect(row?.status).toBe('fail');
    expect(row?.detail).toContain('packages/a/src/load.ts:1');
  });
});
