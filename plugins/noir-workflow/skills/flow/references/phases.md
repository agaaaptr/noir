# /flow — 2-mode phase detail + checkpoint

## Process capability (rich vs lean)
- **Rich (Superpowers available):** Phase 4 → delegate to `superpowers:brainstorming` then `superpowers:writing-plans`; Phase 5 → `superpowers:executing-plans`. You are a **thin router** — do not reimplement brainstorming/plans/TDD.
- **Lean (no Superpowers):** Phase 4 inline — write a concise spec (`docs/specs/YYYY-MM-DD-<topic>.md`) + plan (`docs/plans/YYYY-MM-DD-<topic>.md`) yourself, following Investigate→Confirm→Act (no assumptions; user approves at the gate). Phase 5 execute inline, TDD where the stack supports it, commit per scope, checkpoint review with the user.

## Investigate (Phase 2)
- **Rich:** dispatch a subagent (the `Task` tool in Claude Code; some harnesses expose it as `Agent` — use whichever your harness provides; general-purpose/Explore) — ask for FACTS only (affected files, current behavior, conventions, non-conventional setup); keep the summary, drop raw exploration from the main context.
- **Lean:** explore inline with `Read`/`Grep`; keep a concise summary in the state file.

## Spec/plan paths (override Superpowers default)
specs → `docs/specs/`, plans → `docs/plans/` (per plugin `references/doc-structure.md`) — **not** `docs/superpowers/`. Both `brainstorming` and `writing-plans` accept a user-preferred location.

## Memory (Phase 3, best-effort)
- Rich (agentmemory): `memory_save` the confirmed understanding + Q&A.
- Lean: the `workflow/<task>.md` state file is the source of truth — it always survives.

## Checkpoint (interrupt / end of session, at any phase)
- **Always:** update `workflow/<task>.md` — set `phase:` + `status:` (e.g. `in-progress @ phase N`) + `updated:` timestamp, append a History-log line, and fill "done so far" + "next steps" + any blockers. This is the durable resume record (matches `/checkpoint`).
- **If agentmemory:** `memory_save` the checkpoint (best-effort).
- Surface: "Checkpoint saved — resume with `/flow <task>`."
- The `/checkpoint` skill + `/wrap` formalize end-of-session checkpoint + doc tidy.
