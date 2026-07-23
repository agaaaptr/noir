# CLAUDE.md

Project instructions for Claude Code (this repo).

## What this is
[Project name] — [one-line purpose].

## Stack
- Language/framework: [e.g. Go 1.22 / React 18 / Laravel 11]
- Package manager: [e.g. go mod / npm / composer]
- Test command: [e.g. `go test ./...` / `npm test` / `php artisan test`]
- Run command: [e.g. `sh ./run_local.sh 8080 true` / `npm run dev`]

## Conventions
- [naming, architecture, gotchas — fill as you learn them]

## Commands
- Build: [cmd]
- Test: [cmd]
- Run: [cmd]

## AI workflow (`noir-workflow`)

This project uses `noir-workflow` (`/init`, `/sync`, `/flow`, `/wrap`, `/checkpoint`). Plugins (Superpowers, context-mode, agentmemory) are **optional** — 2-mode (rich/lean). Override: `noir-workflow.mode: auto|rich|lean`.

**Doc layout:** permanent `docs/{specs,plans,decisions,architecture,reference,handoffs,findings}/` + `docs/DOC-POLICY.md`; ephemeral (gitignored) `.session/`, `.superpowers/sdd/`. **Superpowers paths:** specs → `docs/specs/`, plans → `docs/plans/` (not `docs/superpowers/`).

> Keep this file concise. Put durable "why" decisions in `docs/decisions/` (ADRs) and link them here.
