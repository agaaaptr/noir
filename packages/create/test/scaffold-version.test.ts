import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCAFFOLD_VERSION,
  readScaffoldVersion,
  scaffoldVersionPath,
  writeScaffoldVersion,
} from '../src/scaffold-version.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-sv-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scaffold-version', () => {
  it('writeScaffoldVersion + readScaffoldVersion round-trip', () => {
    writeScaffoldVersion(root, '1.2.3');
    expect(readScaffoldVersion(root)).toBe('1.2.3');
  });

  it('writeScaffoldVersion creates .noir/ if absent', () => {
    expect(existsSync(join(root, '.noir'))).toBe(false);
    writeScaffoldVersion(root, '1.0.0');
    expect(existsSync(scaffoldVersionPath(root))).toBe(true);
  });

  it('stamp format is a single `noir-scaffold=<v>\\n` line', () => {
    writeScaffoldVersion(root, '0.4.2');
    expect(readFileSync(scaffoldVersionPath(root), 'utf8')).toBe('noir-scaffold=0.4.2\n');
  });

  it('readScaffoldVersion returns null when the stamp is absent', () => {
    expect(readScaffoldVersion(root)).toBeNull();
  });

  it('readScaffoldVersion returns null for a malformed stamp (no `noir-scaffold=` line)', () => {
    writeScaffoldVersion(root, '1.0.0');
    // Overwrite with garbage. (writeScaffoldVersion is the only legit writer;
    // reaching past it here is intentional for the negative case.)
    writeFileSync(scaffoldVersionPath(root), 'garbage\nnoir-other=1\n', 'utf8');
    expect(readScaffoldVersion(root)).toBeNull();
  });

  it('readScaffoldVersion skips blank/comment lines and finds the key line anywhere in the file', () => {
    // This test reaches past `writeScaffoldVersion` (which would mkdir `.noir/`)
    // and raw-writes the stamp, so the dir has to exist first.
    mkdirSync(dirname(scaffoldVersionPath(root)), { recursive: true });
    writeFileSync(scaffoldVersionPath(root), '\n# comment\nnoir-scaffold=2.0.0\n', 'utf8');
    expect(readScaffoldVersion(root)).toBe('2.0.0');
  });

  it('CURRENT_SCAFFOLD_VERSION is a bare x.y.z semver (no v-prefix, no pre-release)', () => {
    expect(CURRENT_SCAFFOLD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
