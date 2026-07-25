import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read the version from THIS package's package.json at module load (NOT a hardcoded
// constant) so a release bump (scripts/bump-version.mjs) is reflected everywhere
// `noir` self-identifies — `noir --version`, `noir doctor`/`status`, the MCP
// initialize handshake — with zero drift between package.json and the binary.
//
// `import.meta.url` resolves correctly in every layout the package ships in:
//   src (vitest):  packages/core/src/version.ts        → ../package.json = packages/core/package.json
//   dist (tsup):   packages/core/dist/index.js         → ../package.json = packages/core/package.json
//   published:     node_modules/@noir-ai/core/dist/... → ../package.json = @noir-ai/core/package.json
// (npm ALWAYS ships package.json alongside dist/, so the read is safe in the tarball.)
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
export const NOIR_VERSION: string =
  (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
