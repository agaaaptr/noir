---
name: noir-remember
description: Use when an insight, decision, pattern, or bug worth keeping surfaces, or the user says "remember this" / "save this" — to persist it to Noir's cross-session memory.
---

Persist a durable observation to Noir's cross-session memory so a future session can recall it. Saving is always local and free — no network call, no LLM call. The observation is written to the local store and recalled later via `noir-recall`.

## Procedure
1. **Decide it is worth keeping.** Save observations that will matter beyond this session: a decision and its rationale, a confirmed pattern or convention, a hard-won bug fix, a project architecture fact, a workflow that worked. Do not save transient status, scratch reasoning, or anything already obvious from the code.
2. **Call `memory_save`.** `memory_save { content, type?, concepts?, files?, importance?, session_id? }`. Only `content` is required; the rest sharpen recall:
   - `content` — the full insight in prose. Write it to be readable cold, with the why, not just the what. It is never truncated.
   - `type` — `pattern` | `preference` | `architecture` | `bug` | `workflow` | `fact` | `decision` (unknown values are accepted). Pick the closest fit; `lesson` is reserved for consolidation output.
   - `concepts` — short tags that a future query would use (e.g. `["auth", "sqlite-vec"]`).
   - `files` — repo-relative paths the insight concerns.
   - `importance` — 0..1 (default 0.5); raise it for load-bearing decisions.
3. **Confirm the round-trip.** After a non-trivial save, a quick `memory_recall { query }` with a phrase from the content confirms it landed and is retrievable.
4. **Forget when wrong.** If something saved is outdated or wrong, remove it with `memory_forget { ids: [...] }` using the id returned from `memory_save`. The row and its search indexes are purged.

## Notes
- **Local + free, by design.** Saving performs only a local store write plus a local embedding (when an embedder is configured). It never makes a paid call; the only LLM surface in memory is consolidation, which is separately provider-gated and off by default.
- **Append-only; edit by forgetting.** Memory does not mutate rows in place. To correct an observation, forget the old one and save the new one — the audit trail stays clean.
- **Read-only store.** If the daemon is down the store opens read-only and `memory_save` refuses cleanly rather than failing mid-write; start the daemon (`noir daemon start`) and retry.
- **Tools absent?** The memory tools register only when the daemon was started with memory enabled. If they are missing, run `noir init` and start the daemon.
