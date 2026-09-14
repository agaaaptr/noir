// doctor — doc-seed drift.
//
// `.noir/.env.example` is a committable documentation seed the scaffold writes
// once. A later release may change the text it ships; doctor reports a project
// whose file is still an exact copy of an OLDER Noir's seed (the user never
// edited it) with the same `warn` severity as a stale scaffold stamp. Absent,
// current, or user-edited files produce no row.
//
// WHY THE TEMPLATES ARE SUBSTITUTED
// ---------------------------------
// The report compares the bytes on disk against what the current template
// renders to. The packaged template still renders to the bytes recorded for the
// initial scaffold version, so against it drift could never trigger. Pointing
// the loader at a copy whose env.example template carries one added line
// reproduces the state a later release is in. `NOIR_TEMPLATES_DIR` exists for
// exactly this (see the create package's template loader), and the loader reads
// it once at import time — hence the dynamic imports below, after the env var
// is set.
//
// Offline/free: no network, no API key, no embedder.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGED_TEMPLATES = fileURLToPath(new URL('../../create/templates/', import.meta.url));
const TEMPLATES = mkdtempSync(join(tmpdir(), 'noir-doctor-seed-templates-'));
cpSync(PACKAGED_TEMPLATES, TEMPLATES, { recursive: true });
process.env.NOIR_TEMPLATES_DIR = TEMPLATES;

// Imported AFTER the template dir is redirected: the loader resolves its dir
// once at module load, so a static import would pin the packaged templates.
const create = await import('@noir-ai/create');
const { doctor } = await import('../src/commands/doctor.js');

const recorded = create.SEED_TEMPLATE_HISTORY.find((e) => e.scaffoldVersion === '1.1.0');
if (!recorded) throw new Error('template history is missing the initial entry');

// The substituted current render: the recorded bytes plus one added line. The
// seed template has no placeholders, so its render equals its raw text.
const CURRENT_ENV_EXAMPLE = `${recorded.envExample}# SUBSTITUTED: current template adds this line\n`;
writeFileSync(join(TEMPLATES, 'env.example.tmpl'), CURRENT_ENV_EXAMPLE, 'utf8');

afterAll(() => {
  rmSync(TEMPLATES, { recursive: true, force: true });
});

interface DoctorData {
  checks: Array<{ name: string; status: string; detail: string }>;
}

let root: string;
let origCwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-doctor-seed-'));
  origCwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

/** Run `noir doctor --json` and return the parsed `data` envelope. `doctor`
 *  throws when a CRITICAL check fails; the JSON was already written to stdout
 *  first, which is all these assertions need. */
async function runDoctor(): Promise<DoctorData> {
  const out: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    await doctor({ json: true });
  } catch {
    // The throw (exit-code signal) is expected on hosts where a critical check
    // fails; the payload under test was already captured.
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const envelope = JSON.parse(out.join('')) as { ok: boolean; data: DoctorData };
  return envelope.data;
}

const seedPath = (): string => join(root, '.noir', '.env.example');

describe('noir doctor — doc-seed drift', () => {
  it('reports a warn row when .env.example is an unedited older seed', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(seedPath(), recorded.envExample, 'utf8');

    const data = await runDoctor();
    const row = data.checks.find((c) => c.name === 'doc seed');
    expect(row).toBeDefined();
    expect(row?.status).toBe('warn');
    expect(row?.detail).toContain('.noir/.env.example');
    expect(row?.detail).toContain('noir init --upgrade');
  });

  it('reports nothing when .env.example is already current', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(seedPath(), CURRENT_ENV_EXAMPLE, 'utf8');

    const data = await runDoctor();
    expect(data.checks.find((c) => c.name === 'doc seed')).toBeUndefined();
  });

  it('reports nothing when .env.example is absent', async () => {
    const data = await runDoctor();
    expect(data.checks.find((c) => c.name === 'doc seed')).toBeUndefined();
  });

  it('reports nothing for a user-edited .env.example', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(seedPath(), `${recorded.envExample}\n# our token\nMY_TOKEN=abc\n`, 'utf8');

    const data = await runDoctor();
    expect(data.checks.find((c) => c.name === 'doc seed')).toBeUndefined();
  });
});
