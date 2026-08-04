# Noir Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a pnpm/tsup monorepo whose `noir` CLI exposes one MCP tool (`noir.host_status`) that round-trips from Claude Code over stdio (Gate 1), then promote the same handler to a daemon-backed Streamable HTTP server with graceful stdio fallback (Gate 2).

**Architecture:** 4-package `@noir-ai/*` monorepo. `core` holds types + config schema (no I/O). `daemon` holds one MCP handler core plus two transport bindings (stdio in-process + Streamable HTTP behind an auto-managed daemon). `adapters` holds the `HostAdapter` interface + the `claude` emitter. `cli` holds the `noir` bin, `noir init`, `noir mcp serve`, and `noir daemon start|stop`. Built on the official MCP TypeScript SDK **v2 beta** (`@modelcontextprotocol/server` + `@modelcontextprotocol/node` + `@modelcontextprotocol/client`).

**Tech Stack:** pnpm workspaces, TypeScript (ESM, NodeNext), tsup, vitest, Biome, GitHub Actions, zod v4, MCP TS SDK v2.

## Global Constraints

(Copied verbatim from `docs/internal/specs/2026-07-23-noir-walking-skeleton-design.md`. Every task's requirements implicitly include these.)

- **MCP SDK = v2 beta:** deps `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/client` (install latest `2.x` beta; stable expected 2026-07-28). Imports: `McpServer` from `@modelcontextprotocol/server`; `StdioServerTransport` from `@modelcontextprotocol/server/stdio`; `NodeStreamableHTTPServerTransport`, `localhostHostValidation`, `localhostOriginValidation` from `@modelcontextprotocol/node`; `Client`, `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`; `StdioClientTransport` from `@modelcontextprotocol/client/stdio`. Schema lib: `import * as z from 'zod/v4'`.
- **Module system = ESM:** every package `"type": "module"`; relative TS imports use `.js` extensions; moduleResolution `NodeNext`.
- **Toolchain:** pnpm + tsup + vitest + Biome + TypeScript. Node `>=20` (`.nvmrc` pins `22`).
- **Packages (4):** `@noir-ai/core`, `@noir-ai/daemon`, `@noir-ai/adapters`, `@noir-ai/cli`. Do not create `store`/`skills`/`model`/`create`.
- **Names:** marketplace `noir`, plugin `noir-workflow`, scoped npm `@noir-ai/*`, bin `noir`.
- **LICENSE = MIT.**
- **stdio logging discipline:** stdout is reserved for JSON-RPC. Every `console.*` / log in a stdio-serving code path writes to **stderr** (`process.stderr`).
- **No `Date.now()` in plan-author context** — irrelevant here; daemon/runtime code may freely use `Date.now()`.
- **TDD:** every code task writes the failing test first, watches it fail, implements minimally, watches it pass, then commits.

---

## File Structure

```
noir/
├─ package.json                      # root workspace + scripts
├─ pnpm-workspace.yaml               # packages: [packages/*]
├─ tsconfig.base.json                # shared strict ESM TS config
├─ biome.json                        # lint + format
├─ vitest.config.ts                  # root test runner; aliases @noir-ai/* → src
├─ .nvmrc                            # 22
├─ LICENSE                           # MIT
├─ .github/workflows/ci.yml          # install→lint→typecheck→build→test
├─ packages/
│  ├─ core/
│  │  ├─ package.json                # @noir-ai/core
│  │  ├─ tsconfig.json               # extends ../../tsconfig.base.json
│  │  ├─ tsup.config.ts
│  │  ├─ src/index.ts                # public barrel
│  │  ├─ src/version.ts              # NOIR_VERSION
│  │  ├─ src/project-id.ts           # ProjectId + createProjectId
│  │  ├─ src/config.ts               # NoirConfigSchema (zod) + parseConfig
│  │  ├─ src/layout.ts               # .noir/ path helpers
│  │  ├─ src/project.ts              # ProjectInfo + loadProjectInfo
│  │  └─ test/{config,project-id,project}.test.ts
│  ├─ daemon/
│  │  ├─ package.json                # @noir-ai/daemon
│  │  ├─ tsconfig.json / tsup.config.ts
│  │  ├─ src/index.ts                # public barrel
│  │  ├─ src/status.ts               # HostStatus + buildStatus
│  │  ├─ src/server.ts               # createNoirServer(ctx) → McpServer
│  │  ├─ src/stdio.ts                # startStdioServer(ctx)
│  │  ├─ src/http.ts                 # startHttpServer(opts) → { url, stop }
│  │  ├─ src/lifecycle.ts            # daemon.json, ensureDaemonRunning, pidAlive, stale reclaim, idle-stop
│  │  └─ test/{status,http,lifecycle}.test.ts
│  ├─ adapters/
│  │  ├─ package.json                # @noir-ai/adapters
│  │  ├─ tsconfig.json / tsup.config.ts
│  │  ├─ src/index.ts
│  │  ├─ src/types.ts                # HostAdapter interface
│  │  ├─ src/claude.ts               # claudeAdapter (emitMcpConfig, emitContext)
│  │  └─ test/claude.test.ts
│  └─ cli/
│     ├─ package.json                # @noir-ai/cli; bin "noir" → dist/bin.js
│     ├─ tsconfig.json / tsup.config.ts  # entry: index.ts + bin.ts
│     ├─ src/index.ts
│     ├─ src/bin.ts                  # arg dispatch (shebang)
│     ├─ src/init.ts                 # init(root, opts)
│     ├─ src/serve.ts                # serve(opts) — stdio or daemon-prefer
│     ├─ src/daemon-cmd.ts           # daemon start|stop
│     ├─ src/doctor.ts               # stub
│     └─ test/{init,serve}.test.ts
```

**Dependency direction:** `core` ← `adapters`, `daemon` ← `cli`. `adapters` depends only on `core`. `daemon` depends on `core` + MCP SDK. `cli` depends on `core` + `daemon` + `adapters`.

---

## Task 1: Monorepo + toolchain scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.nvmrc`, `LICENSE`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsup.config.ts`, `packages/core/src/index.ts`
- Modify: `.gitignore` (add `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`)

**Interfaces:**
- Produces: a buildable empty `@noir-ai/core` package and a green `pnpm install && pnpm lint && pnpm typecheck`.

- [ ] **Step 1: Write the failing smoke test**

Create `packages/core/test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { NOIR_VERSION } from '../src/index.js';

describe('monorepo smoke', () => {
  it('exposes a version string', () => {
    expect(typeof NOIR_VERSION).toBe('string');
    expect(NOIR_VERSION.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Create root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
```

`package.json` (root):
```json
{
  "name": "noir",
  "private": true,
  "version": "0.1.0",
  "description": "Noir — the discipline, context, and memory layer for any agentic CLI.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@9",
  "scripts": {
    "build": "pnpm -r --filter './packages/*' run build",
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "pnpm -r --filter './packages/*' run typecheck",
    "test": "pnpm build && vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

`.nvmrc`:
```
22
```

`LICENSE` (MIT, copyright holder `agaaaptr`, year `2026`):
```
MIT License

Copyright (c) 2026 agaaaptr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/dist", "!**/node_modules"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" } }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const alias = (pkg: string) => fileURLToPath(new URL(`packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@noir-ai/core': alias('core'),
      '@noir-ai/daemon': alias('daemon'),
      '@noir-ai/adapters': alias('adapters'),
      '@noir-ai/cli': alias('cli'),
    },
  },
  test: {
    include: [`${root}packages/*/test/**/*.test.ts`],
    testTimeout: 15000,
  },
});
```

Append to `.gitignore` (create if missing):
```
node_modules/
dist/
*.tsbuildinfo
coverage/
```

- [ ] **Step 3: Create the empty `core` package**

`packages/core/package.json`:
```json
{
  "name": "@noir-ai/core",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": { "yaml": "^2.5.0", "zod": "^3.25.0" }
}
```
> Note on zod: the v2 SDK imports `zod/v4`, available from `zod@^3.25+` (which ships the `zod/v4` subpath) and from `zod@4`. If `import * as z from 'zod/v4'` fails to resolve at install time, bump `zod` to `^4.0.0`.

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/core/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm'], dts: true, clean: true, sourcemap: true });
```

`packages/core/src/index.ts`:
```ts
export const NOIR_VERSION = '0.1.0';
```

- [ ] **Step 4: Install, run the smoke test, lint, typecheck**

Run: `pnpm install`
Run: `pnpm test`
Expected: PASS — `monorepo smoke > exposes a version string`.

Run: `pnpm lint`
Expected: Biome reports no errors (may suggest formatting; run `pnpm format` if so).

Run: `pnpm typecheck`
Expected: `tsc --noEmit` passes for `core`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json biome.json vitest.config.ts .nvmrc LICENSE .gitignore packages/core
git commit -m "feat(core): monorepo scaffold + toolchain (pnpm/tsup/vitest/biome)"
```

---

## Task 2: `@noir-ai/core` domain (config schema, project id, layout, project loader)

**Files:**
- Create: `packages/core/src/{version.ts,project-id.ts,config.ts,layout.ts,project.ts}`, `packages/core/test/{config,project-id,project}.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

**Interfaces:**
- Produces (consumed by later tasks):
  - `NOIR_VERSION: string`
  - `type ProjectId = string`; `createProjectId(): ProjectId`
  - `NoirConfig` type; `NoirConfigSchema`; `parseConfig(raw: unknown): NoirConfig`
  - `paths` object: `{ noirDir(root), noirMd(root), config(root), projectId(root) }`
  - `ProjectInfo` = `{ id: ProjectId; name: string; root: string; config: NoirConfig }`; `loadProjectInfo(root: string): ProjectInfo`
  - `NoirConfig.host` is `'claude'`; `NoirConfig.mode` is `'full' | 'quick'`; `NoirConfig.daemon` is `{ idleTimeoutSec: number; port?: number }`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/project-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createProjectId } from '../src/project-id.js';

describe('createProjectId', () => {
  it('returns a non-empty string', () => {
    const id = createProjectId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
  it('is unique across calls', () => {
    expect(createProjectId()).not.toBe(createProjectId());
  });
});
```

`packages/core/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies defaults for a minimal config', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.host).toBe('claude');
    expect(cfg.mode).toBe('full');
    expect(cfg.daemon.idleTimeoutSec).toBe(900);
    expect(cfg.daemon.port).toBeUndefined();
  });
  it('accepts a full config', () => {
    const cfg = parseConfig({ host: 'claude', mode: 'quick', daemon: { idleTimeoutSec: 60, port: 4321 } });
    expect(cfg.mode).toBe('quick');
    expect(cfg.daemon.port).toBe(4321);
  });
  it('rejects an unknown host', () => {
    expect(() => parseConfig({ host: 'gemini' })).toThrow();
  });
});
```

`packages/core/test/project.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInfo } from '../src/project.js';
import { createProjectId } from '../src/project-id.js';
import { paths } from '../src/layout.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noir-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('loadProjectInfo', () => {
  it('reads project.id + config.yml', () => {
    const id = createProjectId();
    writeFileSync(paths.projectId(root), id, 'utf8');
    writeFileSync(paths.config(root), 'host: claude\nmode: quick\n', 'utf8');
    const info = loadProjectInfo(root);
    expect(info.id).toBe(id);
    expect(info.config.mode).toBe('quick');
    expect(info.root).toBe(root);
    expect(typeof info.name).toBe('string');
    expect(info.name.length).toBeGreaterThan(0);
  });
  it('throws clearly when not initialized', () => {
    expect(() => loadProjectInfo(root)).toThrow(/noir init/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — modules `../src/project-id.js`, `../src/config.js`, `../src/project.js`, `../src/layout.js` not found.

- [ ] **Step 3: Implement the modules**

`packages/core/src/project-id.ts`:
```ts
import { randomUUID } from 'node:crypto';

/** Canonical, machine-stable project identity. NEVER a filesystem path. */
export type ProjectId = string;

export function createProjectId(): ProjectId {
  return randomUUID();
}
```

`packages/core/src/config.ts`:
```ts
import * as z from 'zod/v4';

export const NoirConfigSchema = z.object({
  host: z.literal('claude'),
  name: z.string().optional(),
  mode: z.enum(['full', 'quick']).default('full'),
  daemon: z
    .object({
      idleTimeoutSec: z.number().int().positive().default(900),
      port: z.number().int().min(0).max(65535).optional(),
    })
    .default({ idleTimeoutSec: 900 }),
});

export type NoirConfig = z.infer<typeof NoirConfigSchema>;

export function parseConfig(raw: unknown): NoirConfig {
  return NoirConfigSchema.parse(raw);
}
```

`packages/core/src/layout.ts`:
```ts
import { join } from 'node:path';

export const NOIR_DIR = '.noir';

export const paths = {
  noirDir: (root: string) => join(root, NOIR_DIR),
  noirMd: (root: string) => join(root, NOIR_DIR, 'NOIR.md'),
  config: (root: string) => join(root, NOIR_DIR, 'config.yml'),
  projectId: (root: string) => join(root, NOIR_DIR, 'project.id'),
} as const;
```

`packages/core/src/project.ts`:
```ts
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseConfig, type NoirConfig } from './config.js';
import { paths } from './layout.js';
import type { ProjectId } from './project-id.js';

export interface ProjectInfo {
  id: ProjectId;
  name: string;
  root: string;
  config: NoirConfig;
}

export function loadProjectInfo(root: string): ProjectInfo {
  let rawId: string;
  let rawConfig: unknown;
  try {
    rawId = readFileSync(paths.projectId(root), 'utf8').trim();
    rawConfig = parseYaml(readFileSync(paths.config(root), 'utf8'));
  } catch {
    throw new Error(`Noir is not initialized in ${root}. Run \`noir init\` first.`);
  }
  const config = parseConfig(rawConfig);
  return {
    id: rawId,
    name: config.name ?? basename(root),
    root,
    config,
  };
}
```

`packages/core/src/index.ts` (replace contents):
```ts
export { NOIR_VERSION } from './version.js';
export { createProjectId, type ProjectId } from './project-id.js';
export { NoirConfigSchema, parseConfig, type NoirConfig } from './config.js';
export { paths, NOIR_DIR } from './layout.js';
export { loadProjectInfo, type ProjectInfo } from './project.js';
```

Move the version into its own file: `packages/core/src/version.ts`:
```ts
export const NOIR_VERSION = '0.1.0';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: all `core` tests PASS.
Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): config schema, project id, .noir layout, project loader"
```

---

## Task 3: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI that runs on every push/PR: install → lint → typecheck → build → test, on Ubuntu + macOS, Node 22.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main, develop]
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
```

- [ ] **Step 2: Verify locally that the pipeline maps to real scripts**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all four pass locally (mirrors CI).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: github actions (lint/typecheck/build/test, ubuntu+macos, node 22)"
```

---

## Task 4: S0 branding — rebrand the legacy plugin

**Files:**
- Rename: `plugins/ai-dev-workflow/` → `plugins/noir-workflow/`
- Modify: `.claude-plugin/marketplace.json`, `plugins/noir-workflow/**/*` (internal references), `README.md`, `AGENTS.md`

**Interfaces:**
- Produces: marketplace `name` = `noir`; plugin `name` = `noir-workflow`; `source` = `./plugins/noir-workflow`; no stale `ai-toolkit` / `ai-dev-workflow` identifiers remain.

- [ ] **Step 1: Rename the directory**

Run: `git mv plugins/ai-dev-workflow plugins/noir-workflow`

- [ ] **Step 2: Rewrite marketplace.json**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "noir",
  "owner": { "name": "agaaaptr", "url": "https://github.com/agaaaptr" },
  "plugins": [
    {
      "name": "noir-workflow",
      "source": "./plugins/noir-workflow",
      "description": "Noir's spec-driven development workflow for Claude Code — 2-mode (runs with OR without plugins). Skills: /init bootstrap, /sync context-load, /flow plan->execute->verify->document loop (investigate-confirm-act gates), /wrap session close, /checkpoint resume. The Noir-native distribution channel; superseded by the Noir CLI at runtime."
    }
  ]
}
```

- [ ] **Step 3: Find and update internal references**

Run: `grep -rIl "ai-toolkit\|ai-dev-workflow" plugins README.md AGENTS.md docs --exclude-dir=.git`
Expected: a list of files still mentioning the old names.

For each listed file, replace:
- `ai-toolkit` → `noir`
- `ai-dev-workflow` → `noir-workflow`

(Preserve any historical references inside `docs/internal/specs/**` and `docs/plans/**` that describe past work — those are dated records, not live identity. Only update live files: the plugin's `SKILL.md`/`references/`/`templates/`, root `README.md`, root `AGENTS.md`.)

- [ ] **Step 4: Verify no stale identifiers in live files**

Run: `grep -rIn "ai-toolkit\|ai-dev-workflow" plugins README.md AGENTS.md .claude-plugin`
Expected: no matches.

Validate the marketplace JSON parses:
Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')); console.log('marketplace.json OK')"`
Expected: `marketplace.json OK`.

- [ ] **Step 5: Commit**

```bash
git add plugins .claude-plugin/marketplace.json README.md AGENTS.md
git commit -m "refactor(brand): rebrand plugin to noir-workflow / marketplace noir"
```

---

## Task 5: `@noir-ai/daemon` — status + server factory + stdio binding

**Files:**
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/tsup.config.ts`, `packages/daemon/src/{index.ts,status.ts,server.ts,stdio.ts}`, `packages/daemon/test/status.test.ts`

**Interfaces:**
- Consumes (from `@noir-ai/core`): `ProjectInfo`, `NOIR_VERSION`.
- Produces:
  - `type Transport = 'stdio' | 'streamable-http'`
  - `HostStatus` = `{ noir: string; project: { id: string; name: string }; host: string; transport: Transport; daemon: boolean; pid?: number; uptimeSec?: number }`
  - `buildStatus(project: ProjectInfo, ctx: { transport: Transport; daemon: boolean; pid?: number; startedAt?: number }): HostStatus`
  - `ServerContext` = `{ project: ProjectInfo; transport: Transport; daemon: boolean; pid?: number; startedAt?: number }`
  - `createNoirServer(ctx: ServerContext): McpServer` (registers the `host_status` tool)
  - `startStdioServer(ctx: ServerContext): Promise<void>`

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/status.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildStatus } from '../src/status.js';
import type { ProjectInfo } from '@noir-ai/core';

const project: ProjectInfo = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'demo',
  root: '/tmp/demo',
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

describe('buildStatus', () => {
  it('stdio, no daemon', () => {
    const s = buildStatus(project, { transport: 'stdio', daemon: false });
    expect(s).toMatchObject({ noir: expect.any(String), host: 'claude', transport: 'stdio', daemon: false });
    expect(s.project).toEqual({ id: project.id, name: 'demo' });
    expect(s).not.toHaveProperty('pid');
    expect(s).not.toHaveProperty('uptimeSec');
  });
  it('daemon includes pid and uptime', () => {
    const startedAt = Date.now() - 5_000;
    const s = buildStatus(project, { transport: 'streamable-http', daemon: true, pid: 1234, startedAt });
    expect(s.daemon).toBe(true);
    expect(s.transport).toBe('streamable-http');
    expect(s.pid).toBe(1234);
    expect(s.uptimeSec).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/status.js` not found (and `@noir-ai/daemon` package not yet created).

- [ ] **Step 3: Create the package and implement**

`packages/daemon/package.json`:
```json
{
  "name": "@noir-ai/daemon",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0-beta.0",
    "@modelcontextprotocol/node": "^2.0.0-beta.0",
    "@noir-ai/core": "workspace:*",
    "zod": "^3.25.0"
  }
}
```

`packages/daemon/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/daemon/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm'], dts: true, clean: true, sourcemap: true });
```

`packages/daemon/src/status.ts`:
```ts
import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';

export type Transport = 'stdio' | 'streamable-http';

export interface HostStatus {
  noir: string;
  project: { id: string; name: string };
  host: string;
  transport: Transport;
  daemon: boolean;
  pid?: number;
  uptimeSec?: number;
}

export interface StatusContext {
  transport: Transport;
  daemon: boolean;
  pid?: number;
  startedAt?: number;
}

export function buildStatus(project: ProjectInfo, ctx: StatusContext): HostStatus {
  const status: HostStatus = {
    noir: NOIR_VERSION,
    project: { id: project.id, name: project.name },
    host: project.config.host,
    transport: ctx.transport,
    daemon: ctx.daemon,
  };
  if (ctx.pid !== undefined) status.pid = ctx.pid;
  if (ctx.startedAt !== undefined) status.uptimeSec = Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000));
  return status;
}
```

`packages/daemon/src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';
import { buildStatus, type Transport } from './status.js';

export interface ServerContext {
  project: ProjectInfo;
  transport: Transport;
  daemon: boolean;
  pid?: number;
  startedAt?: number;
}

export function createNoirServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: 'noir', version: NOIR_VERSION });
  server.registerTool(
    'host_status',
    {
      description: "Report Noir's runtime status: project id/name, host CLI, transport, and daemon state.",
      inputSchema: z.object({}),
    },
    async () => {
      const status = buildStatus(ctx.project, ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
    },
  );
  return server;
}
```

`packages/daemon/src/stdio.ts`:
```ts
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createNoirServer, type ServerContext } from './server.js';

export async function startStdioServer(ctx: ServerContext): Promise<void> {
  const server = createNoirServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

`packages/daemon/src/index.ts`:
```ts
export { buildStatus, type HostStatus, type Transport, type StatusContext } from './status.js';
export { createNoirServer, type ServerContext } from './server.js';
export { startStdioServer } from './stdio.js';
```

Re-run `pnpm install` to link the new workspace package and fetch MCP deps:
Run: `pnpm install`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: `buildStatus` tests PASS.
Run: `pnpm typecheck`
Expected: passes (including `@modelcontextprotocol/server` types resolve).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon pnpm-lock.yaml package.json
git commit -m "feat(daemon): host_status status, McpServer factory, stdio binding"
```

---

## Task 6: `@noir-ai/adapters` — HostAdapter interface + claude emitter

**Files:**
- Create: `packages/adapters/package.json`, `packages/adapters/tsconfig.json`, `packages/adapters/tsup.config.ts`, `packages/adapters/src/{index.ts,types.ts,claude.ts}`, `packages/adapters/test/claude.test.ts`

**Interfaces:**
- Consumes: none beyond `core` paths.
- Produces:
  - `EmitContext` = `{ root: string }`
  - `McpConfigOptions` = `{ transport: 'stdio' | 'streamable-http'; url?: string }`
  - `HostAdapter` = `{ readonly id: string; emitMcpConfig(ctx: EmitContext, opts: McpConfigOptions): string; emitContext(ctx: EmitContext): string; install?(ctx: EmitContext): Promise<void>; healthCheck?(ctx: EmitContext): Promise<boolean> }`
  - `claudeAdapter: HostAdapter`
  - `CONTEXT_BLOCK_BEGIN = '<!-- noir:context begin -->'`, `CONTEXT_BLOCK_END = '<!-- noir:context end -->'`

- [ ] **Step 1: Write the failing test**

`packages/adapters/test/claude.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { claudeAdapter, CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '../src/claude.js';

describe('claudeAdapter', () => {
  const ctx = { root: '/tmp/demo' };

  it('emits a stdio .mcp.json that spawns `noir mcp serve --stdio`', () => {
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'stdio' }));
    expect(json.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });

  it('emits an http .mcp.json with the given url', () => {
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http', url: 'http://127.0.0.1:4321/mcp' }));
    expect(json.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });

  it('emits a CLAUDE.md @import block wrapped in markers', () => {
    const block = claudeAdapter.emitContext(ctx);
    expect(block).toContain(CONTEXT_BLOCK_BEGIN);
    expect(block).toContain(CONTEXT_BLOCK_END);
    expect(block).toContain('@import ".noir/NOIR.md"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/claude.js` not found.

- [ ] **Step 3: Implement**

`packages/adapters/package.json`:
```json
{
  "name": "@noir-ai/adapters",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": { "@noir-ai/core": "workspace:*" }
}
```

`packages/adapters/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/adapters/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm'], dts: true, clean: true, sourcemap: true });
```

`packages/adapters/src/types.ts`:
```ts
export interface EmitContext {
  root: string;
}

export interface McpConfigOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

export interface HostAdapter {
  readonly id: string;
  /** Full contents of the host's MCP config file (e.g. .mcp.json). */
  emitMcpConfig(ctx: EmitContext, opts: McpConfigOptions): string;
  /** Managed block to insert into the host's context file (e.g. CLAUDE.md). */
  emitContext(ctx: EmitContext): string;
  install?(ctx: EmitContext): Promise<void>;
  healthCheck?(ctx: EmitContext): Promise<boolean>;
}
```

`packages/adapters/src/claude.ts`:
```ts
import type { HostAdapter, McpConfigOptions, EmitContext } from './types.js';

export const CONTEXT_BLOCK_BEGIN = '<!-- noir:context begin -->';
export const CONTEXT_BLOCK_END = '<!-- noir:context end -->';

export const claudeAdapter: HostAdapter = {
  id: 'claude',
  emitMcpConfig(_ctx, opts: McpConfigOptions): string {
    const server =
      opts.transport === 'stdio'
        ? { command: 'noir', args: ['mcp', 'serve', '--stdio'] }
        : { type: 'http', url: opts.url ?? 'http://127.0.0.1:0/mcp' };
    return JSON.stringify({ mcpServers: { noir: server } }, null, 2);
  },
  emitContext(_ctx: EmitContext): string {
    return `${CONTEXT_BLOCK_BEGIN}\n@import ".noir/NOIR.md"\n${CONTEXT_BLOCK_END}\n`;
  },
};
```

`packages/adapters/src/index.ts`:
```ts
export { claudeAdapter, CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from './claude.js';
export { type HostAdapter, type McpConfigOptions, type EmitContext } from './types.js';
```

Run: `pnpm install`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: `claudeAdapter` tests PASS.
Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters pnpm-lock.yaml package.json
git commit -m "feat(adapters): HostAdapter interface + claude emitter"
```

---

## Task 7: `@noir-ai/cli` — bin, `noir init`, `noir mcp serve --stdio`

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/tsup.config.ts`, `packages/cli/src/{index.ts,bin.ts,init.ts,serve.ts,doctor.ts}`, `packages/cli/test/init.test.ts`

**Interfaces:**
- Consumes: `loadProjectInfo`, `createProjectId`, `paths`, `NoirConfigSchema` (core); `startStdioServer` (daemon); `claudeAdapter`, `CONTEXT_BLOCK_BEGIN/END` (adapters).
- Produces: a `noir` bin that dispatches `init`, `mcp serve [--stdio]`, `daemon start|stop` (stubbed until Task 10), `doctor` (stubbed). `init(root, opts)` writes `.noir/NOIR.md`, `.noir/config.yml`, `.noir/project.id`, and root `.mcp.json` + `CLAUDE.md`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../src/init.js';
import { paths, CONTEXT_BLOCK_BEGIN } from '@noir-ai/core'; // CONTEXT_BLOCK_BEGIN re-exported below; see note

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noir-cli-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
  });
});
```

> Note: the test imports `CONTEXT_BLOCK_BEGIN` from `@noir-ai/core`. Add it to core's barrel in Step 3 (re-export from adapters is not possible across packages without a dep). Simplest: define the marker constants in `@noir-ai/core` and have `adapters` import them from core. Adjust Step 3 accordingly (add `markers.ts` to core).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/init.js` not found.

- [ ] **Step 3: Implement**

First, add shared marker constants to core so both adapters and cli use the same source. Create `packages/core/src/markers.ts`:
```ts
export const CONTEXT_BLOCK_BEGIN = '<!-- noir:context begin -->';
export const CONTEXT_BLOCK_END = '<!-- noir:context end -->';
```
Append to `packages/core/src/index.ts`:
```ts
export { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from './markers.js';
```
Update `packages/adapters/src/claude.ts` to import markers from core instead of defining them:
```ts
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '@noir-ai/core';
```
and delete the two `export const` lines for the markers in `claude.ts` (keep `claudeAdapter`). Update `packages/adapters/src/index.ts` to re-export them from core:
```ts
export { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '@noir-ai/core';
export { claudeAdapter } from './claude.js';
export { type HostAdapter, type McpConfigOptions, type EmitContext } from './types.js';
```

Now the CLI package. `packages/cli/package.json`:
```json
{
  "name": "@noir-ai/cli",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "bin": { "noir": "./dist/bin.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@noir-ai/core": "workspace:*",
    "@noir-ai/daemon": "workspace:*",
    "@noir-ai/adapters": "workspace:*"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }, { "path": "../daemon" }, { "path": "../adapters" }]
}
```

`packages/cli/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
```
> Note: applying the shebang banner to every entry is fine; only `bin.js` is invoked directly.

`packages/cli/src/init.ts`:
```ts
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProjectId, paths, CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '@noir-ai/core';
import { claudeAdapter } from '@noir-ai/adapters';

export interface InitOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

export async function init(root: string, opts: InitOptions): Promise<void> {
  mkdirSync(paths.noirDir(root), { recursive: true });

  const id = createProjectId();
  writeFileSync(paths.projectId(root), `${id}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  writeFileSync(
    paths.noirMd(root),
    `# Noir context\n\nProject id: \`${id}\`\n\n<!-- Noir auto-manages this file. Host context files @import it. -->\n`,
    'utf8',
  );

  writeFileSync(join(root, '.mcp.json'), `${claudeAdapter.emitMcpConfig({ root }, opts)}\n`, 'utf8');

  const existing = safeRead(join(root, 'CLAUDE.md'));
  writeFileSync(join(root, 'CLAUDE.md'), replaceBlock(existing, claudeAdapter.emitContext({ root })), 'utf8');

  process.stderr.write(`Noir initialized in ${root} (transport: ${opts.transport}).\n`);
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function replaceBlock(content: string, block: string): string {
  const begin = CONTENT_BLOCK_BEGIN;
  const end = CONTENT_BLOCK_END;
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'g');
  const stripped = content.replace(re, '');
  return `${stripped ? `${stripped.trimEnd()}\n\n` : ''}${block}`;
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

`packages/cli/src/serve.ts`:
```ts
import { loadProjectInfo } from '@noir-ai/core';
import { startStdioServer } from '@noir-ai/daemon';

export async function serve(opts: { stdio: boolean }): Promise<void> {
  const project = loadProjectInfo(process.cwd());
  if (opts.stdio) {
    await startStdioServer({ project, transport: 'stdio', daemon: false });
    return; // stdio server runs until stdin closes
  }
  // Daemon-prefer path arrives in Task 10. Until then, default to stdio.
  process.stderr.write('Daemon transport not implemented yet; falling back to stdio.\n');
  await startStdioServer({ project, transport: 'stdio', daemon: false });
}
```

`packages/cli/src/doctor.ts`:
```ts
export async function doctor(): Promise<void> {
  process.stderr.write('noir doctor: not implemented in the walking skeleton.\n');
}
```

`packages/cli/src/bin.ts`:
```ts
import { parseArgs } from 'node:util';
import { init } from './init.js';
import { serve } from './serve.js';
import { doctor } from './doctor.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'init') {
    const { values } = parseArgs({
      options: {
        transport: { type: 'string', default: 'stdio' },
        url: { type: 'string' },
      },
      args: argv.slice(1),
    });
    const transport = values.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    await init(process.cwd(), { transport, url: values.url });
    return;
  }

  if (cmd === 'mcp') {
    const sub = argv[1];
    if (sub !== 'serve') {
      process.stderr.write('Usage: noir mcp serve [--stdio]\n');
      process.exitCode = 2;
      return;
    }
    const { values } = parseArgs({ options: { stdio: { type: 'boolean', default: false } }, args: argv.slice(2) });
    await serve({ stdio: values.stdio });
    return;
  }

  if (cmd === 'daemon') {
    process.stderr.write('noir daemon start|stop arrives in Task 10.\n');
    process.exitCode = 0;
    return;
  }

  if (cmd === 'doctor') {
    await doctor();
    return;
  }

  process.stderr.write('Noir — commands: init | mcp serve [--stdio] | daemon start|stop | doctor\n');
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  process.stderr.write(`noir: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
```

`packages/cli/src/index.ts`:
```ts
export { init, type InitOptions } from './init.js';
export { serve } from './serve.js';
export { doctor } from './doctor.js';
```

Run: `pnpm install`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: `init` test PASS.
Run: `pnpm typecheck`
Expected: passes.
Run: `pnpm build`
Expected: `packages/cli/dist/bin.js` exists and starts with `#!/usr/bin/env node`.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/adapters packages/cli pnpm-lock.yaml package.json
git commit -m "feat(cli): noir bin, init scaffolder, mcp serve --stdio"
```

---

## Task 8: Gate 1 integration test — stdio round-trip

**Files:**
- Create: `packages/cli/test/gate1-stdio.test.ts`, `packages/cli/package.json` (add `@modelcontextprotocol/client` devDep)

**Interfaces:**
- Consumes: the built/source CLI bin entry `packages/cli/src/bin.ts` (spawned via `node --import tsx`), `Client` + `StdioClientTransport` from `@modelcontextprotocol/client`.

> This task implements **Gate 1 acceptance (a)** from the spec.

- [ ] **Step 1: Add the MCP client dev dependency**

Add to `packages/cli/package.json` `devDependencies`:
```json
"devDependencies": { "@modelcontextprotocol/client": "^2.0.0-beta.0" }
```
Run: `pnpm install`

- [ ] **Step 2: Write the failing integration test (hermetic temp cwd)**

`packages/cli/test/gate1-stdio.test.ts` (uses an isolated temp dir so it never touches the real repo):
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, URL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

describe('Gate 1 — stdio round-trip', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'noir-gate1-'));
    execFileSync(process.execPath, ['--import', 'tsx', BIN, 'init'], { cwd, stdio: 'ignore' });
  }, 20000);

  it('noir.host_status returns transport=stdio over stdio', async () => {
    const client = new Client({ name: 'noir-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', BIN, 'mcp', 'serve', '--stdio'],
      cwd,
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'host_status', arguments: {} });
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.transport).toBe('stdio');
      expect(parsed.daemon).toBe(false);
      expect(parsed.host).toBe('claude');
      expect(parsed.project.id.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 20000);
});
```
> Confirm `StdioClientTransport` accepts a `cwd` option in the installed SDK version; if it does not, set `process.chdir(cwd)` in `beforeAll` and restore the original cwd in an `afterAll`.

- [ ] **Step 3: Run the test to verify it fails first, then passes**

Run: `pnpm test packages/cli/test/gate1-stdio.test.ts`
Expected: PASS (stdio server spawns, MCP handshake completes, `host_status` returns `transport: 'stdio'`).

- [ ] **Step 4: Run the full suite + typecheck + build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all green. **This is Gate 1 acceptance (a) — automated.**

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "test(cli): Gate 1 integration — stdio host_status round-trip"
```

---

## Task 9: `@noir-ai/daemon` — Streamable HTTP server + health + lifecycle files

**Files:**
- Create: `packages/daemon/src/{http.ts,lifecycle.ts}`, `packages/daemon/test/{http.test.ts,lifecycle.test.ts}`
- Modify: `packages/daemon/src/index.ts`, `packages/daemon/package.json` (add `@modelcontextprotocol/client` devDep)

**Interfaces:**
- Consumes: `createNoirServer`, `buildStatus` (daemon), `loadProjectInfo`, `paths` (core), `NodeStreamableHTTPServerTransport`, `localhostHostValidation`, `localhostOriginValidation` (`@modelcontextprotocol/node`).
- Produces:
  - `startHttpServer(opts: { project: ProjectInfo; port?: number; idleTimeoutSec: number }): Promise<{ port: number; stop: () => Promise<void> }>` — binds `127.0.0.1`, exposes `GET /health` and `POST /mcp` (Streamable HTTP), writes `~/.noir/daemon.json`.
  - `DaemonRecord` = `{ pid: number; port: number; startedAt: number }`; `daemonJsonPath(): string`; `readDaemonRecord(): DaemonRecord | null`; `writeDaemonRecord(rec): void`; `clearDaemonRecord(): void`; `pidAlive(pid: number): boolean`.

- [ ] **Step 1: Add client devDep and write failing lifecycle test**

Add to `packages/daemon/package.json` `devDependencies`:
```json
"devDependencies": { "@modelcontextprotocol/client": "^2.0.0-beta.0" }
```

`packages/daemon/test/lifecycle.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { daemonJsonPath, readDaemonRecord, writeDaemonRecord, clearDaemonRecord, pidAlive } from '../src/lifecycle.js';

afterEach(() => { clearDaemonRecord(); });

describe('daemon lifecycle files', () => {
  it('round-trips a DaemonRecord in ~/.noir/daemon.json', () => {
    writeDaemonRecord({ pid: 4242, port: 5555, startedAt: 1 });
    const rec = readDaemonRecord();
    expect(rec).toEqual({ pid: 4242, port: 5555, startedAt: 1 });
  });
  it('clearDaemonRecord removes the file', () => {
    writeDaemonRecord({ pid: 1, port: 2, startedAt: 3 });
    clearDaemonRecord();
    expect(readDaemonRecord()).toBeNull();
  });
  it('pidAlive is true for the current process', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
  it('pidAlive is false for an unlikely pid', () => {
    expect(pidAlive(2_000_000)).toBe(false);
  });
  it('daemonJsonPath lives under ~/.noir', () => {
    expect(daemonJsonPath()).toBe(join(homedir(), '.noir', 'daemon.json'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/lifecycle.js` not found.

- [ ] **Step 3: Implement lifecycle.ts**

`packages/daemon/src/lifecycle.ts`:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

export interface DaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
}

export function noirHome(): string {
  return join(homedir(), '.noir');
}

export function daemonJsonPath(): string {
  return join(noirHome(), 'daemon.json');
}

export function readDaemonRecord(): DaemonRecord | null {
  try {
    const raw = readFileSync(daemonJsonPath(), 'utf8');
    const rec = JSON.parse(raw) as DaemonRecord;
    if (typeof rec.pid === 'number' && typeof rec.port === 'number') return rec;
    return null;
  } catch {
    return null;
  }
}

export function writeDaemonRecord(rec: DaemonRecord): void {
  mkdirSync(noirHome(), { recursive: true });
  writeFileSync(daemonJsonPath(), `${JSON.stringify(rec)}\n`, 'utf8');
}

export function clearDaemonRecord(): void {
  if (existsSync(daemonJsonPath())) rmSync(daemonJsonPath(), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write the failing HTTP test**

`packages/daemon/test/http.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { clearDaemonRecord } from '../src/lifecycle.js';
import type { ProjectInfo } from '@noir-ai/core';

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'http-demo',
  root: '/tmp/http-demo',
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

describe('startHttpServer', () => {
  it('serves /health 200 and host_status over Streamable HTTP', async () => {
    clearDaemonRecord();
    const { port, stop } = await startHttpServer({ project, idleTimeoutSec: 900 });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { ok: boolean; pid: number };
      expect(body.ok).toBe(true);

      const client = new Client({ name: 'noir-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const result = await client.callTool({ name: 'host_status', arguments: {} });
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.transport).toBe('streamable-http');
      expect(parsed.daemon).toBe(true);
      expect(typeof parsed.pid).toBe('number');
      await client.close();
    } finally {
      await stop();
      clearDaemonRecord();
    }
  }, 20000);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/http.js` not found.

- [ ] **Step 6: Implement http.ts**

`packages/daemon/src/http.ts`:
```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import type { ProjectInfo } from '@noir-ai/core';
import { createNoirServer } from './server.js';
import { writeDaemonRecord, clearDaemonRecord, type DaemonRecord } from './lifecycle.js';

export interface StartHttpOptions {
  project: ProjectInfo;
  port?: number;
  idleTimeoutSec: number;
}

export interface RunningDaemon {
  port: number;
  pid: number;
  startedAt: number;
  stop: () => Promise<void>;
}

export async function startHttpServer(opts: StartHttpOptions): Promise<RunningDaemon> {
  const startedAt = Date.now();
  const pid = process.pid;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | undefined = setInterval(() => {
    if (Date.now() - lastActivity > opts.idleTimeoutSec * 1000) void shutdown();
  }, 10_000);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    lastActivity = Date.now();
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }));
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (req.url === '/mcp') {
      const server = createNoirServer({ project: opts.project, transport: 'streamable-http', daemon: true, pid, startedAt });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404).end('not found');
  });

  const port: number = await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = httpServer.address();
      httpServer.removeListener('error', reject);
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const rec: DaemonRecord = { pid, port, startedAt };
  writeDaemonRecord(rec);

  async function shutdown(): Promise<void> {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = undefined; }
    await new Promise<void>((r) => httpServer.close(() => r()));
    clearDaemonRecord();
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void shutdown().then(() => process.exit(0)));
  }

  return { port, pid, startedAt, stop: shutdown };
}
```

Re-export in `packages/daemon/src/index.ts` (append):
```ts
export { startHttpServer, type RunningDaemon, type StartHttpOptions } from './http.js';
export { readDaemonRecord, writeDaemonRecord, clearDaemonRecord, pidAlive, daemonJsonPath, noirHome, type DaemonRecord } from './lifecycle.js';
```

Run: `pnpm install`

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: lifecycle + http tests PASS.
Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon pnpm-lock.yaml package.json
git commit -m "feat(daemon): Streamable HTTP server, /health, daemon.json lifecycle"
```

---

## Task 10: daemon lifecycle controls — `noir daemon start|stop`, ensureDaemonRunning, stale reclaim, idle-stop wiring

**Files:**
- Create: `packages/daemon/src/ensure.ts`, `packages/daemon/test/ensure.test.ts`
- Modify: `packages/daemon/src/index.ts`, `packages/cli/src/{daemon-cmd.ts,bin.ts,serve.ts}`

**Interfaces:**
- Consumes: `startHttpServer`, `readDaemonRecord`, `writeDaemonRecord`, `clearDaemonRecord`, `pidAlive`, `loadProjectInfo`.
- Produces:
  - `ensureDaemonRunning(opts: { project: ProjectInfo; idleTimeoutSec: number }): Promise<{ port: number; url: string; started: boolean }>` — if a healthy daemon record exists, reuse it; else start one. Reclaims stale records (pid dead).
  - `noir daemon start` and `noir daemon stop` CLI subcommands.
  - `noir mcp serve` (no `--stdio`) now prefers the daemon; on failure logs to stderr and falls back to in-process stdio (FS degradation).
  > This task implements **Gate 2 acceptance (a)** (shared-state + degradation).

- [ ] **Step 1: Write the failing ensure test**

`packages/daemon/test/ensure.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { ensureDaemonRunning } from '../src/ensure.js';
import { clearDaemonRecord } from '../src/lifecycle.js';
import type { ProjectInfo } from '@noir-ai/core';
// Node 20+ provides a global fetch (typed via @types/node); no import needed.

const project: ProjectInfo = {
  id: 'ensure',
  name: 'ensure-demo',
  root: '/tmp/ensure',
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

afterEach(() => { clearDaemonRecord(); });

describe('ensureDaemonRunning', () => {
  it('starts a daemon and reports a health URL', async () => {
    const { url, started } = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    expect(started).toBe(true);
    const res = await fetch(`${url.replace(/\/mcp$/, '')}/health`);
    expect(res.status).toBe(200);
  }, 20000);

  it('reuses an already-running healthy daemon (started=false)', async () => {
    const first = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    const second = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    expect(second.started).toBe(false);
    expect(second.url).toBe(first.url);
  }, 20000);

  it('reclaims a stale record (pid dead) and starts fresh', async () => {
    // write a bogus record pointing at a dead pid
    const { writeDaemonRecord } = await import('../src/lifecycle.js');
    writeDaemonRecord({ pid: 2_000_000, port: 1, startedAt: 1 });
    const { started } = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    expect(started).toBe(true);
  }, 20000);
});
```

> `global fetch` is available on Node 20+. If the test runner can't see it, `import { fetch } from 'undici'`. Prefer global fetch and add `undici` only if typecheck complains.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/ensure.js` not found.

- [ ] **Step 3: Implement ensure.ts**

`packages/daemon/src/ensure.ts`:
```ts
import type { ProjectInfo } from '@noir-ai/core';
import { startHttpServer, readDaemonRecord, clearDaemonRecord, pidAlive } from './lifecycle.js';

export interface EnsureResult {
  port: number;
  url: string;
  started: boolean;
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(opts: { project: ProjectInfo; idleTimeoutSec: number }): Promise<EnsureResult> {
  const rec = readDaemonRecord();
  if (rec) {
    if (pidAlive(rec.pid) && await isHealthy(rec.port)) {
      return { port: rec.port, url: `http://127.0.0.1:${rec.port}/mcp`, started: false };
    }
    clearDaemonRecord(); // stale — pid dead or health failed
  }
  const running = await startHttpServer({ project: opts.project, idleTimeoutSec: opts.idleTimeoutSec });
  return { port: running.port, url: `http://127.0.0.1:${running.port}/mcp`, started: true };
}
```

Export it from `packages/daemon/src/index.ts`:
```ts
export { ensureDaemonRunning, type EnsureResult } from './ensure.js';
```

- [ ] **Step 4: Wire CLI `daemon start|stop` and daemon-prefer `serve`**

`packages/cli/src/daemon-cmd.ts`:
```ts
import { loadProjectInfo } from '@noir-ai/core';
import { ensureDaemonRunning, readDaemonRecord, clearDaemonRecord } from '@noir-ai/daemon';

export async function daemonStart(): Promise<void> {
  const project = loadProjectInfo(process.cwd());
  const { url, started } = await ensureDaemonRunning({ project, idleTimeoutSec: project.config.daemon.idleTimeoutSec });
  process.stderr.write(`${started ? 'Started' : 'Reused'} Noir daemon at ${url}\n`);
}

export async function daemonStop(): Promise<void> {
  const rec = readDaemonRecord();
  if (!rec) {
    process.stderr.write('No Noir daemon is running.\n');
    return;
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
    process.stderr.write(`Stopped Noir daemon (pid ${rec.pid}).\n`);
  } finally {
    clearDaemonRecord();
  }
}
```

Update `packages/cli/src/serve.ts` to prefer the daemon and fall back to stdio:
```ts
import { loadProjectInfo } from '@noir-ai/core';
import { startStdioServer, ensureDaemonRunning } from '@noir-ai/daemon';

export async function serve(opts: { stdio: boolean }): Promise<void> {
  const project = loadProjectInfo(process.cwd());
  if (opts.stdio) {
    await startStdioServer({ project, transport: 'stdio', daemon: false });
    return;
  }
  try {
    const { url } = await ensureDaemonRunning({ project, idleTimeoutSec: project.config.daemon.idleTimeoutSec });
    process.stderr.write(`Noir daemon available at ${url}. (For HTTP clients, use this URL in .mcp.json.)\n`);
  } catch (err) {
    process.stderr.write(`Noir daemon unavailable (${err instanceof Error ? err.message : String(err)}); falling back to stdio.\n`);
    await startStdioServer({ project, transport: 'stdio', daemon: false });
  }
}
```

Update `packages/cli/src/bin.ts` `daemon` branch:
```ts
  if (cmd === 'daemon') {
    const sub = argv[1];
    const { daemonStart, daemonStop } = await import('./daemon-cmd.js');
    if (sub === 'start') { await daemonStart(); return; }
    if (sub === 'stop') { await daemonStop(); return; }
    process.stderr.write('Usage: noir daemon start|stop\n');
    process.exitCode = 2;
    return;
  }
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `pnpm test`
Expected: ensure + lifecycle + http + gate1 tests all PASS.
Run: `pnpm typecheck && pnpm build`
Expected: green. **Gate 2 acceptance (a) is met (shared daemon across calls + stale reclaim + healthy reuse + stdio fallback path exists in serve).**

- [ ] **Step 6: Add an explicit degradation assertion (daemon killed → stdio still serves)**

Add to `packages/cli/test/gate1-stdio.test.ts` a second test proving the stdio path works independently of the daemon (the FS-fallback proof):
```ts
  it('stdio still works when no daemon is running (FS-fallback)', async () => {
    const client = new Client({ name: 'noir-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', BIN, 'mcp', 'serve', '--stdio'],
      cwd,
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'host_status', arguments: {} });
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.transport).toBe('stdio');
      expect(parsed.daemon).toBe(false);
    } finally {
      await client.close();
    }
  }, 20000);
```
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon packages/cli
git commit -m "feat(daemon,cli): ensureDaemonRunning + daemon start|stop + stdio fallback"
```

---

## Task 11: claude adapter HTTP `.mcp.json` + `noir init --transport streamable-http`

**Files:**
- Modify: `packages/cli/src/{init.ts,bin.ts}`, `packages/adapters/test/claude.test.ts` (extend), `packages/cli/test/init.test.ts` (extend)

**Interfaces:**
- Produces: `noir init --transport streamable-http --url http://127.0.0.1:<port>/mcp` writes an HTTP `.mcp.json`; the claude adapter already supports it (Task 6).

- [ ] **Step 1: Extend the adapter test for the HTTP url default**

Add to `packages/adapters/test/claude.test.ts`:
```ts
  it('http without explicit url uses a placeholder to be edited', () => {
    const json = JSON.parse(claudeAdapter.emitMcpConfig(ctx, { transport: 'streamable-http' }));
    expect(json.mcpServers.noir.type).toBe('http');
    expect(json.mcpServers.noir.url).toMatch(/^http:\/\/127\.0\.0\.1/);
  });
```

- [ ] **Step 2: Run to verify it passes (already implemented in Task 6)**

Run: `pnpm test packages/adapters`
Expected: PASS.

- [ ] **Step 3: Extend the init test for the http transport**

Add to `packages/cli/test/init.test.ts`:
```ts
  it('scaffolds an http .mcp.json when transport is streamable-http', async () => {
    await init(root, { transport: 'streamable-http', url: 'http://127.0.0.1:4321/mcp' });
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS. (The bin already parses `--transport`/`--url` from Task 7; `init` already forwards them.)

- [ ] **Step 5: Commit**

```bash
git add packages/adapters packages/cli
git commit -m "test(adapters,cli): http .mcp.json via init --transport streamable-http"
```

---

## Task 12: `noir doctor` stub, README, manual Gate 1 & Gate 2 checklist

**Files:**
- Modify: `packages/cli/src/doctor.ts`, `README.md`
- Create: `docs/internal/plans/2026-07-23-noir-walking-skeleton-acceptance.md`

**Interfaces:**
- Produces: a `noir doctor` that prints toolchain + daemon health; a README section for install/dev; a manual acceptance checklist covering Gate 1 (b) and Gate 2 (b).

- [ ] **Step 1: Implement a minimal doctor**

Replace `packages/cli/src/doctor.ts`:
```ts
import { readDaemonRecord, pidAlive } from '@noir-ai/daemon';

export async function doctor(): Promise<void> {
  const lines: string[] = [];
  lines.push(`node: ${process.version}`);
  lines.push(`platform: ${process.platform}`);
  const rec = readDaemonRecord();
  if (rec) {
    lines.push(`daemon record: pid=${rec.pid} port=${rec.port} alive=${pidAlive(rec.pid)}`);
  } else {
    lines.push('daemon record: none');
  }
  process.stderr.write(`noir doctor\n${lines.join('\n')}\n`);
}
```
(Add `@noir-ai/daemon` to cli deps — already present.)

- [ ] **Step 2: Add README install/dev section**

Append a `## Noir (toolkit) — developer setup` section to `README.md`:
```markdown
## Noir (toolkit) — developer setup

The Noir CLI lives under `packages/`. From the repo root:

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # vitest (unit + integration)
pnpm lint           # biome
```

Run the CLI locally without a global install:

```bash
node packages/cli/dist/bin.js init          # scaffold .noir/ in cwd
node packages/cli/dist/bin.js mcp serve --stdio
node packages/cli/dist/bin.js daemon start
```
```

- [ ] **Step 3: Write the manual acceptance checklist**

`docs/internal/plans/2026-07-23-noir-walking-skeleton-acceptance.md`:
```markdown
# Noir Walking Skeleton — Manual Acceptance

## Gate 1 (stdio round-trip) — thesis proof
1. `pnpm build`
2. In a scratch project dir: `node packages/cli/dist/bin.js init`
3. Confirm `.noir/` (NOIR.md, config.yml, project.id) and root `.mcp.json` + `CLAUDE.md` exist.
4. Open that dir in Claude Code (the `.mcp.json` points Claude at `noir mcp serve --stdio`).
5. Invoke the `noir` MCP tool -> `host_status`. **Expected:** JSON with `transport: "stdio"`, `daemon: false`, `host: "claude"`, and a non-empty `project.id`.

> If `noir` is not on PATH, either `pnpm link --global` the cli, or edit `.mcp.json` to `{"mcpServers":{"noir":{"command":"node","args":["<repo>/packages/cli/dist/bin.js","mcp","serve","--stdio"]}}}`.

## Gate 2 (daemon-backed) — shared state + degradation
1. `node packages/cli/dist/bin.js daemon start` -> prints a `http://127.0.0.1:<port>/mcp` URL.
2. `curl http://127.0.0.1:<port>/health` -> `{"ok":true,"pid":...,"uptimeSec":...}`.
3. (Optional) `node packages/cli/dist/bin.js init --transport streamable-http --url http://127.0.0.1:<port>/mcp`, then in Claude Code invoke `host_status`. **Expected:** `transport: "streamable-http"`, `daemon: true`, `pid` present.
4. Start a second Claude Code session against the same daemon; both report the same `pid` (shared daemon).
5. `node packages/cli/dist/bin.js daemon stop`; then `node packages/cli/dist/bin.js mcp serve --stdio` still answers `host_status` with `transport: "stdio"` (FS fallback).
```

- [ ] **Step 4: Final full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor.ts README.md docs/internal/plans/2026-07-23-noir-walking-skeleton-acceptance.md
git commit -m "feat(cli,docs): noir doctor stub, dev README, manual acceptance checklist"
```

---

## Notes for the implementer

- **MCP v2 beta churn:** the SDK is beta until 2026-07-28. If an import path or option name differs in the installed version, trust the installed package's `.d.ts` over this plan and adjust; keep behavior identical.
- **`server.connect()` per HTTP request:** the official Node example connects a transport per request (stateless, `sessionIdGenerator: undefined`). The plan follows that. If a given v2 build rejects repeated `connect()` on one `McpServer`, create a fresh server per request inside the handler (call `createNoirServer(ctx)` per request) — the handler is cheap.
- **stdout purity:** never `console.log` in `stdio.ts`/`server.ts`/`http.ts` request paths — it corrupts the JSON-RPC stream on stdio. All diagnostics use `process.stderr`.
- **zod subpath:** if `import * as z from 'zod/v4'` does not resolve, bump `zod` to `^4.0.0` across packages.
- **Hermetic tests:** Gate 1 and ensure tests use temp cwds / temp records; do not mutate the real repo's `.noir/`.
