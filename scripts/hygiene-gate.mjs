#!/usr/bin/env node
// CI gate for the output-hygiene check.
//
// A fail-tier finding blocks the merge (exit 1); warn-tier findings are printed
// and do not block (exit 0). The scope — which files are read, which
// directories are excluded, the caps — is `scanOutputHygiene` in
// packages/cli/src/hygiene-scan.ts, the same scan `noir doctor` reports, so CI
// and the doctor check cannot drift apart. The exemption markers and the
// planning-corpus exclusions are part of that scan, so this script honours them
// without a list of its own. The summary line (including what the scan left
// out) is `hygieneCounts` from the same module — this script re-derives none of
// it, and reaches for the counts rather than `hygieneDetail` because every
// finding is already printed on its own line above.
//
// Offline and free: reads files under the repository only, no network, no key.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Import the DECLARED subpath (@noir-ai/cli/hygiene-scan → dist/hygiene-scan.js)
// rather than a dist-relative path, so the gate exercises the same entry a
// consumer gets. On a fresh clone dist/ does not exist yet: fail with a clear
// message instead of a module-not-found stack.
if (!existsSync(join(root, 'packages', 'cli', 'dist', 'hygiene-scan.js'))) {
  console.error('output hygiene: @noir-ai/cli is not built — run `pnpm build` first');
  process.exit(1);
}
const { hygieneCounts, scanOutputHygiene } = await import('@noir-ai/cli/hygiene-scan');

const result = scanOutputHygiene(root);

for (const f of result.findings) {
  if (f.tier === 'fail') console.log(`FAIL ${f.path}:${f.line} ${f.id}`);
  else console.log(`warn ${f.path}:${f.line} ${f.id}`);
}

console.log(`output hygiene: ${hygieneCounts(result)}`);

if (result.fail > 0) process.exitCode = 1;
