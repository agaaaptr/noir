# Contributing to Noir

Thanks for wanting to contribute to **Noir** — the discipline, context, and memory layer for agentic CLIs. This guide covers how to contribute code, docs, and roadmap changes to this repository.

> **New to the codebase?** Read [`AGENTS.md`](AGENTS.md) first — it is the operational manual for developing Noir (toolchain, conventions, commit discipline, privacy rules). This file is the human-facing contribution policy; AGENTS.md is the agent-facing companion that points here.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Reporting bugs & requesting features](#reporting-bugs--requesting-features)
- [Pull request process](#pull-request-process)
- [Code standards & testing](#code-standards--testing)
- [Documentation & roadmap changes](#documentation--roadmap-changes)
- [License](#license)

---

## Code of conduct

Be respectful, kind, and collaborative. Harassment-free interaction is expected of everyone. (The project does not yet have a standalone `CODE_OF_CONDUCT.md`; the behavioral expectation is the standard open-source one — respect every contributor regardless of identity or skill level.)

## Getting started

**Prerequisites:**

- Node.js **>= 22** (see `.nvmrc`)
- [pnpm](https://pnpm.io) **10.12.4** (`packageManager` in `package.json`)

**Set up the dev environment:**

```bash
# 1. Install dependencies (frozen lockfile)
pnpm install --frozen-lockfile

# 2. Build all packages
pnpm build

# 3. Verify everything works
pnpm typecheck && pnpm lint && pnpm test
```

The full test suite runs **offline and free** — it must never depend on a network call or a paid API key. Do not claim a change is done until all four gates (`build`, `typecheck`, `lint`, `test`) are green.

> This repo is a **pnpm monorepo** of 11 `@noir-ai/*` packages. See [`AGENTS.md`](AGENTS.md) for the toolchain contract and [`docs/how-to/packaging.md`](docs/how-to/packaging.md) for how packages are structured.

## Development workflow

This repo dogfoods **Spec-Driven Development (SDD)**: brainstorm → spec → plan → subagent-driven implement + review → final review. Before you start:

1. **Find or open an issue** describing what you want to do.
2. **Discuss the approach** — for non-trivial work, write a short spec (or at least a plan) before code. Specs/plans live under `docs/internal/{specs,plans}` for this repo's own dogfooding; for a contribution, a clear PR description + linked issue is the minimum.
3. **Branch strategy:** the default branch is `develop`. Work on a feature branch (`feat/...`, `fix/...`). Do **not** commit directly to `main`.
4. **Keep your branch up to date** with `develop`.

### Commit conventions

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- **Commit per scope** — never bundle unrelated changes; group by logical unit. Use package scope where relevant: `feat(skills): …`, `fix(cli): …`, `docs(memory): …`.
- **Local commits** — commits stay local on `develop`; **pushing requires explicit confirmation**. Never auto-push.

## Reporting bugs & requesting features

- **Bugs:** include steps to reproduce, expected vs actual behavior, environment (OS, node version), and any relevant logs. Use the issue templates if present.
- **Feature requests:** describe the problem you're solving and the desired behavior. Frame it as a use case, not just a solution.
- **Security issues:** do not open a public issue for a security vulnerability — report it privately (see the repo owner / maintainer).

## Pull request process

1. **Before opening a PR:** sync with `develop`, run the full gate (`pnpm build && pnpm typecheck && pnpm lint && pnpm test`), and `pnpm docs:validate`.
2. **Write a clear PR description** linking the issue (`Closes #123`).
3. **Open as a draft** until it's ready for full review.
4. **CI must pass** — the matrix runs lint → build → typecheck → test → docs:validate on ubuntu + macos (node 22).
5. **Respond to review feedback** — address or discuss each comment. Reviews are about making the change correct, not about winning an argument.
6. **Tests:** add or update tests for your change. Unit + integration tests are expected; see [`AGENTS.md`](AGENTS.md) for the discipline.

### PR checklist

- [ ] All four gates green locally (`build`, `typecheck`, `lint`, `test`)
- [ ] `pnpm docs:validate` passes
- [ ] Tests added/updated for the change
- [ ] Docs updated where behavior changed
- [ ] No secrets committed
- [ ] Conventional Commit message + scope
- [ ] `Co-Authored-By` trailer if AI-assisted (see below)

### AI-assisted contributions

If you use AI coding tools (Claude Code, Cursor, Copilot, …) to produce changes, add a `Co-Authored-By: <tool>` trailer to the commit so the assistance is transparent. A human must understand and take responsibility for every change — AI is assistive, not generative-by-default.

## Code standards & testing

- **Lint / format:** Biome. `pnpm lint` (check) and `pnpm format` (write).
- **TypeScript:** strict ESM (`NodeNext`, `strict`, `noUncheckedIndexedAccess`). `pnpm typecheck`.
- **Tests:** Vitest. `pnpm test` (build + vitest run). Keep the suite offline/free.
- **Docs validation:** `pnpm docs:validate` (broken links, stale version refs, registry integrity).

## Documentation & roadmap changes

- **Code-related docs:** update the relevant `docs/` file in the same change. Docs must reflect the shipped reality — no documentation drift.
- **Roadmap:** the roadmap is a living document under [`docs/roadmap/`](docs/roadmap/). To change it, follow [`docs/roadmap/CONTRIBUTING.md`](docs/roadmap/CONTRIBUTING.md) — the roadmap has its own contribution rules (research-first, ADRs for architecture changes). **This file (root CONTRIBUTING) is for code + general repo contributions; the roadmap has its own scope.**
- **ADRs:** architecture decisions are recorded in `docs/decisions/` (append-only — supersede, never rewrite).

## License

Noir is **MIT**. By contributing, you agree your contributions are licensed under the same terms.
