#!/usr/bin/env node
// CI gate for the output-hygiene check.
//
// A fail-tier finding blocks the merge (exit 1); warn-tier findings are printed
// and do not block (exit 0). The scope — which files are read, which
// directories are excluded, the caps — is `scanOutputHygiene` in
// packages/cli/src/hygiene-scan.ts, the same scan `noir doctor` reports, so CI
// and the doctor check cannot drift apart. The exemption markers and the
// planning-corpus exclusions are part of that scan, so this script honours them
// without a list of its own.
//
// Offline and free: reads files under the repository only, no network, no key.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanOutputHygiene } from '../packages/cli/dist/hygiene-scan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = scanOutputHygiene(root);

for (const f of result.findings) {
  if (f.tier === 'fail') console.log(`FAIL ${f.path}:${f.line} ${f.id}`);
  else console.log(`warn ${f.path}:${f.line} ${f.id}`);
}

const notes = [];
if (result.skipped > 0) notes.push(`${result.skipped} over-size file(s) skipped`);
if (result.truncated) notes.push('stopped at the file cap');
const note = notes.length > 0 ? ` (${notes.join('; ')})` : '';

if (result.scanned === 0) {
  console.log(
    'output hygiene: nothing to scan (no packages/*/src, packages/*/test, scripts/ or documents found)',
  );
} else {
  console.log(
    `output hygiene: ${result.fail} fail, ${result.warn} warn across ${result.scanned} file(s)${note}`,
  );
}

if (result.fail > 0) process.exitCode = 1;
