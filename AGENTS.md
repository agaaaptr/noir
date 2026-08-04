# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Codex, …) working **on this repository** — i.e., developing and maintaining the **Noir toolkit** under `packages/`. For *using* Noir in a project, see the [README](README.md).

## What this repo is

Noir is a host-agnostic, spec-driven-workflow + native-context + cross-session-memory **layer** for agentic CLIs — not an LLM runtime (bring your own agent). v1 host = Claude Code, behind an abstract `HostAdapter`. It is a pnpm monorepo of **11 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory,create}`. Noir ships **only native `noir-` builtin skills (+ opt-in integrations)** — there is no plugin, no marketplace, no slash-command-installed skill surface. See [docs/explanation/architecture.md](docs/explanation/architecture.md).

## Toolchain + conventions (immutable)

- pnpm workspace, `packages/*`. TypeScript ESM: target ES2022, module/moduleResolution NodeNext, `strict` + `noUncheckedIndexedAccess`, declaration. tsup build. Biome lint. Vitest (15s timeout, aliases `@noir-ai/*` → `packages/*/src/index.ts`). CI: ubuntu + macos, node 22. MIT. `engines.node ">=22"`, `packageManager pnpm@10.12.4`.
- The default dev loop:

  ```bash
  pnpm install
  pnpm build && pnpm typecheck && pnpm lint && pnpm test   # build + vitest (unit + integration)
  ```

  Do not claim a change is done until all four are green. The full test suite runs **offline/free** — never make it depend on a network call or a paid key.

- **Don't touch `packages/` source unless that's the task.** Doc-only work (READMEs, ADRs, roadmap) should not edit package source.

## Adding a package

A package is a dir under `packages/` named `@noir-ai/*`. The quickest path is the generator, which scaffolds a publish-ready template **and** wires the one manual papercut (the `vitest.config.ts` source-alias):

```bash
node scripts/new-package.mjs <name>   # e.g. telemetry → @noir-ai/telemetry
pnpm install && pnpm build && pnpm test
```

The new package is **automatically** included in workspace detection, the root build/test, unified versioning (`scripts/bump-version.mjs`), and the `release.yml` publish — nothing to wire. Still manual: adding deps beyond the default `@noir-ai/core`, honoring the blueprint/privacy rules below, and (only if you migrate to OIDC later) registering the new package's Trusted Publisher on npm.

**Add a package only for a genuinely new subsystem/domain.** Host adapters go **inside `@noir-ai/adapters`** (the S10 path), not in a new package; a feature in an existing domain extends the existing package. Full guide (what's automatic vs manual, when to add vs extend): [`docs/how-to/packaging.md`](docs/how-to/packaging.md).

## Dogfood SDD — how work is specified here

This repo dogfoods Noir's own Spec-Driven Development flow: **brainstorm → spec → plan → subagent-driven implement + review → final whole-branch review**. Specs and plans live under `docs/internal/`:

- **Per-slice design specs** → `docs/internal/specs/YYYY-MM-DD-sN-<topic>-design.md`.
- **Per-slice implementation plans** (+ acceptance) → `docs/internal/plans/YYYY-MM-DD-sN-<topic>.md`.
- The single top-level **design blueprint** lives at `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (dated, status: implemented — the one occupant of `docs/internal/specs/`).
- **Architecture Decision Records** → `docs/decisions/NNNN-<slug>.md` (append-only — supersede, never rewrite).
- `.superpowers/` is gitignored local session scratch; never commit it.

## Native skills — the only skill mechanism

There is **no plugin and no marketplace**. Skills are native `noir-` builtins, authored as Claude Code `SKILL.md` files and compiled by `@noir-ai/skills`.

- **Adding a skill** = create `packages/skills/builtin/noir-<kebab>/SKILL.md` (+ optional `references/<kebab>.md`). It is auto-discovered, validated by the compiler, and emitted to the host's `.claude/skills/` on the next `noir init` / `noir sync`. The `noir-*` namespace is **managed** — overwritten on every sync.
- **Frontmatter:** `{ name, description, references? }`. Validation rules (enforced in `packages/skills/src/compiler.ts`):
  - `name` must match `/^noir-[a-z0-9]+(?:-[a-z0-9]+)*$/`, and the directory name must equal `name`.
  - `description` is **WHEN-led** — it must lead with a trigger cue (`Use`/`Using`/`When`/`Before`/`After`/`Upon`/…). A WHAT-summary ("A tool that drafts specs…") is rejected: it becomes a shortcut the agent follows instead of loading the body. ≤ 1024 chars.
  - References are named `<kebab>.md` and non-empty.
- **Compile target is Claude Code only** in v1 (canonical format copied verbatim). Multi-host transform is S10.
- **Forbidden-residue guard** (`packages/skills/src/residue.ts`, `FORBIDDEN_RESIDUE`, checked by the hygiene tests): a native skill must not contain predecessor-plugin internals or Superpowers rhetoric — e.g. `workflow/<task`, `noir-workflow.mode`, `noir-workflow`, `plugins/noir-workflow`, `@uiigateway`, `<EXTREMELY-IMPORTANT`, `SUBAGENT-STOP`. If you are porting an old playbook, scrub these before committing. (Note: `ClickUp`/`clickup` were forbidden during the predecessor-port era but are **allowed again** — Slice X reintroduced ClickUp as a first-class Noir integration under `packages/skills/integrations/noir-clickup/`. The residue list is the source of truth; check it before assuming a token is banned.)

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
- Don't reintroduce a plugin / marketplace / `noir-workflow` surface — it was removed deliberately (see ADR-0002).
