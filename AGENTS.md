# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Codex, …) working **on this repository** — i.e., developing and maintaining the `noir` plugins/skills. For *using* the plugin in a project, see the [README](README.md).

## What this repo is

A Claude Code plugin marketplace shipping the `noir-workflow` plugin (skills: `init`, `sync`, `flow`, `wrap`, `checkpoint`). Skills are Markdown instructions to the model, not executable code; they orchestrate other plugins (Superpowers, context-mode, agentmemory). See [docs/architecture/](docs/architecture/).

## Two modes (rich / lean)

The three plugins (Superpowers, context-mode, agentmemory) are **optional**. Skills run **rich** (plugins present → maximal, more tokens) or **lean** (absent → token-efficient fallbacks, still systematic). Detection is auto (probe availability, per capability) + override via `noir-workflow.mode: auto|rich|lean` in `CLAUDE.md`/`AGENTS.md`. Details: [`plugins/noir-workflow/references/modes.md`](plugins/noir-workflow/references/modes.md). Related references: [`skill-structure.md`](plugins/noir-workflow/references/skill-structure.md), [`commit-push.md`](plugins/noir-workflow/references/commit-push.md), [`doc-structure.md`](plugins/noir-workflow/references/doc-structure.md).

## Layout

- `.claude-plugin/marketplace.json` — marketplace manifest; register new plugins here.
- `plugins/<plugin>/skills/<skill>/SKILL.md` — one file per skill; the source of truth for skill behavior.
- `plugins/<plugin>/templates/` — state-file templates the skills emit.
- `docs/` — architecture, decisions, specs, plans, findings (see [docs/README.md](docs/README.md)).

## Editing a skill

- A `SKILL.md` is YAML frontmatter (`name`, `description`, optional `user-invocable`, `allowed-tools`) + a Markdown body. Keep `description` accurate — it is how the skill is selected.
- Skills are **instructions to the model**. Prefer explicit, numbered, unambiguous steps; state hard rules explicitly.
- `/flow` is a **thin router** — it delegates Plan/Execute to Superpowers. Do not reimplement brainstorming/plans/TDD inside it.
- Validate after editing: re-read the changed region. For logic with a deterministic check (e.g. a version counter), encode it as a tiny script and run it before committing.

## Commit discipline

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- **Commit per scope** — never bundle unrelated changes into one commit; group by logical unit.
- Scope plugin changes: `feat(noir-workflow): …`.
- Push requires explicit user confirmation (never auto-push) — see [`references/commit-push.md`](plugins/noir-workflow/references/commit-push.md).

## Where docs go (overrides Superpowers defaults)

- Design specs → `docs/specs/YYYY-MM-DD-<topic>.md` (not `docs/superpowers/specs/`).
- Implementation plans → `docs/plans/YYYY-MM-DD-<topic>.md` (not `docs/superpowers/plans/`).
- Architecture Decision Records → `docs/decisions/NNNN-<slug>.md`.
- Validation/PoC findings → `docs/findings/`.
- The `brainstorming` and `writing-plans` skills accept a user-preferred location — use the paths above.
- Full doc standard (permanent/ephemeral, DOC-POLICY, curation): [`references/doc-structure.md`](plugins/noir-workflow/references/doc-structure.md).

## Do not

- Don't commit `.superpowers/` (local session scratch; gitignored).
- Don't commit secrets (`CLICKUP_API_TOKEN`, npm tokens, etc.).
- Don't push to `main` without the user's explicit go-ahead.
