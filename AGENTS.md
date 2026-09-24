# AGENTS.md

<!-- noir-hygiene: exempt -->

Guidance for AI coding agents (Claude Code, Cursor, Codex, …) working **on this repository** — i.e., developing and maintaining the **Noir toolkit** under `packages/`. For *using* Noir in a project, see the [README](README.md). The human-facing contribution policy lives in `CONTRIBUTING.md` — read it before opening a PR.

## What this repo is

Noir is a host-agnostic, spec-driven-workflow + native-context + cross-session-memory **layer** for agentic CLIs — not an LLM runtime (bring your own agent). 5 host adapters: `claude` (default), `agents-md`, `gemini`, `cursor`, `opencode` via `resolveAdapter(host)`; `claude` is the regression anchor. It is a pnpm monorepo of **11 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory,create}`. Noir ships **only native `noir-` builtin skills (+ opt-in integrations)** — there is no plugin, no marketplace, no slash-command-installed skill surface. See [docs/explanation/architecture.md](docs/explanation/architecture.md).

## Toolchain + conventions (immutable)

- pnpm workspace, `packages/*`. TypeScript ESM: target ES2022, module/moduleResolution NodeNext, `strict` + `noUncheckedIndexedAccess`, declaration. tsup build. Biome lint. Vitest (`testTimeout: 40000`, aliases `@noir-ai/*` → `packages/*/src/index.ts`). CI: ubuntu + macos, node 22. MIT. `engines.node ">=22"`, `packageManager pnpm@10.12.4`.
- The default dev loop:

  ```bash
  pnpm install
  pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate
  ```

  Do not claim a change is done until all five are green. The full test suite runs **offline/free** — never make it depend on a network call or a paid key.

- **Don't touch `packages/` source unless that's the task.** Doc-only work (READMEs, ADRs, roadmap) should not edit package source.

## Adding a package

A package is a dir under `packages/` named `@noir-ai/*`. The quickest path is the generator, which scaffolds a publish-ready template **and** wires the one manual papercut (the `vitest.config.ts` source-alias):

```bash
node scripts/new-package.mjs <name>   # e.g. telemetry → @noir-ai/telemetry
pnpm install && pnpm build && pnpm test
```

The new package is **automatically** included in workspace detection, the root build/test, unified versioning (`scripts/bump-version.mjs`), and the `release.yml` publish — nothing to wire. Still manual: adding deps beyond the default `@noir-ai/core`, honoring the architecture and privacy rules below, and (only if you migrate to OIDC later) registering the new package's Trusted Publisher on npm.

**Add a package only for a genuinely new subsystem/domain.** Host adapters go **inside `@noir-ai/adapters`** (one registry for every host), not in a new package; a feature in an existing domain extends the existing package. Full guide (what's automatic vs manual, when to add vs extend): [`docs/how-to/packaging.md`](docs/how-to/packaging.md).

## Dogfood SDD — how work is specified here

This repo dogfoods Noir's own Spec-Driven Development flow: **brainstorm → spec → plan → subagent-driven implement + review → final whole-branch review**. Specs and plans live under `docs/internal/`:

- **Design specs** → `docs/internal/specs/YYYY-MM-DD-<topic>-design.md`.
- **Implementation plans** (+ acceptance) → `docs/internal/plans/YYYY-MM-DD-<topic>.md`.
- The single top-level **design document** lives at `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (dated, status: implemented — see `docs/internal/specs/` for the full set of capability design specs).
- **Architecture Decision Records** → `docs/decisions/NNNN-<slug>.md` (append-only — supersede, never rewrite).
- `.superpowers/` is gitignored local session scratch; never commit it.

## No internal jargon in comments or docs

Comments, documentation, and especially user-facing docs must never use shorthand that only resolves against an internal planning document. That means no slice/task codes (something like `X9`), no roadmap codenames or phase markers, and no bare section citations into a spec, plan, or decision record.

Why: those tokens are noise to anyone who does not have the planning docs open. A rationale written in plain words keeps the code and the docs relevant to a reader — including a future contributor who has none of that context.

What IS allowed:

- Decision rationale explained in self-contained plain language.
- A pointer to a named document **alongside** that rationale — an ADR reference is fine when the decision itself is restated next to it. It is never the sole explanation.

## Native skills — the only skill mechanism

There is **no plugin and no marketplace**. Skills are native `noir-` builtins, authored as Claude Code `SKILL.md` files and compiled by `@noir-ai/skills`.

- **Adding a skill** = create `packages/skills/builtin/noir-<kebab>/SKILL.md` (+ optional `references/<kebab>.md`). It is auto-discovered, validated by the compiler, and emitted to the host's `.claude/skills/` on the next `noir init` / `noir sync`. The `noir-*` namespace is **managed** — overwritten on every sync.
- **Frontmatter:** `{ name, description, references?, metadata?, license?, compatibility? }`. Validation rules (enforced in `packages/skills/src/compiler.ts`):
  - `name` must match `/^noir-[a-z0-9]+(?:-[a-z0-9]+)*$/`, and the directory name must equal `name`.
  - `description` is **WHAT+WHEN** — it must lead with a trigger cue (`Use`/`Using`/`When`/`Before`/`After`/`Upon`/…) AND contain a WHAT clause. A WHAT-summary or WHEN-only description is rejected. ≤ 1024 chars.
  - `metadata.{category,version}` is required (structural gate).
  - Body carries required sections: `## When to use`, `## Procedure` (or `## Steps`), and one of `## Verification`/`## Notes`/`## Fallbacks`/`## Troubleshooting`.
  - Body ≤ 500 lines; references one-level deep only (`<kebab>.md`, no chained references).
  - Quality gate: `noir skills lint` reports errors + warnings; `noir skills registry --json` queries the runtime-derived registry.
- **Per-host compile targets.** Skills compile to each host's own shape, not a verbatim copy — `cursor` emits flat `.mdc` files in `.cursor/rules/` (one file per skill, no per-name subdirectory) via `compileSkill(_, 'cursor')`; the other hosts take the canonical `SKILL.md` shape.
- **Forbidden-residue guard** (`packages/skills/src/residue.ts`, `FORBIDDEN_RESIDUE`, checked by the hygiene tests): a native skill must not contain predecessor-plugin internals or Superpowers rhetoric — e.g. `workflow/<task`, `noir-workflow.mode`, `noir-workflow`, `plugins/noir-workflow`, `@uiigateway`, `<EXTREMELY-IMPORTANT`, `SUBAGENT-STOP`. If you are porting an old playbook, scrub these before committing. (Note: `ClickUp`/`clickup` were forbidden during the predecessor-port era but are **allowed again** — ClickUp is now a first-class Noir integration under `packages/skills/integrations/noir-clickup/`. The residue list is the source of truth; check it before assuming a token is banned.)

## Privacy + provider-explicit rules (honor in any change)

- **Local-first by default.** Recall/embedding uses local in-process embeddings (all-MiniLM-L6-v2, 384-dim); remote embedders and any model call are opt-in and provider-explicit.
- **Never a silent paid call.** The model layer resolves the provider solely from explicit config (`req.provider || cfg.defaultProvider`); it is **never** inferred from env-var presence. No provider/key ⇒ `null` / `{ok:false}` **before** an SDK client is constructed. Memory consolidation is gated on its own `memory.consolidation.enabled` master switch and refuses cleanly without a provider.
- **Project-scoped by canonical `ProjectId`**, never a filesystem path.
- **Agent loops are impossible by construction** — the model request type has no `tools`/`stream` parameter.

## Commit discipline

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- **Commit per scope** — never bundle unrelated changes; group by logical unit.
- Scope per package: `feat(skills): …`, `fix(cli): …`, `docs(memory): …`, etc.
- Push requires explicit user confirmation — never auto-push. Commits stay **local** on `develop` until the user says otherwise.

## Do not

- Don't commit `.superpowers/` (local session scratch; gitignored).
- Don't commit secrets (API keys, npm tokens, etc.).
- Don't push to `main` without the user's explicit go-ahead.
- Don't reintroduce a plugin / marketplace / `noir-workflow` surface — it was removed on purpose, because Noir ships only native `noir-` builtin skills and never an installed plugin/marketplace (see ADR-0002).
