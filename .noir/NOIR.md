<!-- noir:brief begin -->
# Noir context

Project id: `d0f014c6-60f0-47f0-91fb-0295b05b4271`

<!-- Noir auto-manages this file. Host context files @import it. -->

## Project baseline

- **Stack:** typescript (monorepo)
- **Package manager:** pnpm
- **CI:** github
- **Commands:**
  - `build`: `pnpm -r --filter './packages/*' run build`
  - `test`: `pnpm build && vitest run`
  - `lint`: `biome check .`
  - `typecheck`: `pnpm -r --filter './packages/*' run typecheck`
  - `format`: `biome format --write .`

## Noir skills (use on demand)

This project ships Noir skills — on-demand playbooks the host loads when a task matches. Route with `noir-sync` (or the SessionStart router contract). Key skills:

- **`noir-brainstorming`** — start of a feature/idea; explore intent before coding.
- **`noir-systematic-debugging`** — any bug or failure; root cause before fix.
- **`noir-test-driven-development`** — implementing; failing test first.
- **`noir-verifying`** — before claiming done; evidence, not assumption.
- **`noir-shipping`** — commit/push/PR; conventional commit, ask before push.
- **`noir-wrap`** — closing a session; verify, docs, memory, handoff.

Full list: `noir skills list` · registry: `noir skills registry --json`.
<!-- noir:brief end -->
