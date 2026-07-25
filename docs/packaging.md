# Adding a package

> How to add a new `@noir-ai/*` package to the Noir monorepo, and when to do it versus extend an existing one.

A **package** is a directory under `packages/` with a `package.json` named `@noir-ai/*`. Noir ships 10 of them today (`core`, `store`, `workflow`, `skills`, `context`, `memory`, `model`, `daemon`, `adapters`, `cli`); the layout, build, test, versioning, and release tooling are all set up so a new package is cheap to add and ships in lockstep with the rest.

## Quickest path: the generator

```bash
node scripts/new-package.mjs <name>     # e.g. node scripts/new-package.mjs telemetry
```

`<name>` is kebab-case (the unqualified directory name; the package becomes `@noir-ai/<name>`). The generator scaffolds a publish-ready template:

- `package.json` — name, **unified version** (inherited from `packages/core`), `publishConfig: { access: "public", provenance: true }`, `engines.node ">=20"`, `repository`/`bugs`/`homepage`, `exports`, `files`, `tsup`/`typecheck` scripts, and a default `@noir-ai/core` workspace dep.
- `tsup.config.ts`, `tsconfig.json` (extends the repo base).
- `src/index.ts` barrel (empty, with a TODO).
- `README.md` stub, `test/smoke.test.ts`.
- **Wires the `vitest.config.ts` source-alias** (`'@noir-ai/<name>': alias('<name>')`) — the one manual papercut, automated.

Then:

```bash
pnpm install          # pick up the new workspace package
pnpm build && pnpm test
# Finally, fill in src/index.ts, the README role, the package.json description/deps, and your real tests.
```

## What you get for free

A package produced by the generator is automatically included in:

- **Workspace detection** — `pnpm -r` sees it (it lives under `packages/*`).
- **Root build + test** — `pnpm build` / `pnpm test` cover it (the vitest alias is wired).
- **Unified versioning** — `node scripts/bump-version.mjs <version>` writes its `package.json` like every other package; there are no per-package versions.
- **The release publish** — `.github/workflows/release.yml` runs `pnpm -r --filter './packages/*' pack` then publishes every packed tarball, so the new package ships on the next tag with no CI edit.

## What is still manual

- **Dependencies** the generator didn't pre-wire (it adds only `@noir-ai/core`). If other packages need to consume the new one, add `workspace:*` deps to those `package.json` files too.
- **Honoring the blueprint + `AGENTS.md` rules** — local-first, provider-explicit (never silent paid) model use, project-scoped canonical IDs, native-skills-only, no agent-loop surface. The generator gives you an empty barrel; what you put in it is your responsibility.
- **(Only under OIDC, later)** registering the new package's Trusted Publisher on npm before its first tag push. Under the current token path (Path A) there is nothing extra to do — the `NPM_TOKEN` already covers the whole `@noir-ai` scope. See [releasing.md §1e](releasing.md#1e-alternative-path--oidc-trusted-publishing-later).

## When to add a package vs. extend one

- **Add a new package** when the work is a **genuinely new subsystem or domain** — its own public API, its own deps, its own release contract — that other packages will consume through a clean interface.
- **Extend an existing package** when the work is a **feature inside a domain that already exists**. A new MCP tool that reads the store goes in `@noir-ai/daemon`; a new retrieval strategy goes in `@noir-ai/context`; a new skill goes under `packages/skills/builtin/`.
- **Host adapters are special.** A new host (OpenCode, Gemini, …) goes **inside `@noir-ai/adapters`**, not in a new package — that is the S10 path. Do not spawn `@noir-ai/opencode`, `@noir-ai/gemini`, etc.

If you find yourself reaching for a new package, check first that the capability doesn't already have a home: the 10-package split was deliberate (see the [design blueprint](specs/2026-07-23-noir-toolkit-design.md)).

## Reference

- `scripts/new-package.mjs` — the generator (short; read it).
- `scripts/bump-version.mjs` — unified versioning (writes every `packages/*/package.json`; never tags or commits — that's a deliberate separate step).
- [releasing.md](releasing.md) — the full release runbook (channels, provenance, irreversibility rules).
