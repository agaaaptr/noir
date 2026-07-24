---
name: noir-recall
description: Use when starting a task, before re-deriving something that may already be known — to recall a prior decision, pattern, bug, or fact from Noir's cross-session memory.
---

Recall what past sessions already learned before re-deriving it. Noir's memory is a local, project-scoped store of observations (pattern / preference / architecture / bug / workflow / fact / decision / lesson) you saved in earlier sessions. Querying it first avoids repeat work and keeps decisions stable across sessions.

## Procedure
1. **Query with intent.** Call `memory_recall { query, limit }` with a natural-language or identifier query (e.g. `"auth token storage"`, `"why sqlite-vec over pgvector"`, `"ContextEngine embed"`). The hybrid path fuses BM25 + vector similarity via RRF and returns ranked observations scoped to memory only — context-index rows never leak in.
2. **Use the instant path for a quick check.** When you only need "does anything mention X" and want no embedding cost, call `memory_search { query }` — BM25-only, faster, still scoped to memory.
3. **Read the full content, not the snippet.** Every returned observation carries its complete `content` (never truncated). Reason over the full text plus its `concepts`, `files`, `type`, and `ts`; cite the observation rather than paraphrasing it loosely.
4. **Scope when useful.** Pass `type` to filter to one kind (e.g. `"decision"`) or `session_id` to limit to one session, when the query is broad.
5. **Act, then stop.** If recall surfaces a relevant decision or pattern, follow it; if it contradicts the current plan, surface the conflict before proceeding. If nothing relevant returns, say so plainly and proceed — absence is not a hidden result.

## Notes
- **Degraded is honest, not broken.** With no embedder configured (or the local model failed to load), `memory_recall` still works in BM25-only mode. A read-only store (daemon down) still serves `memory_recall` and `memory_search`; only writes are fenced off.
- **Hydrate, never truncate.** Recall hydrates each hit from the authoritative store row, so what you read is the full original text — the BM25 snippet is only the preview that ranked it.
- **Tools absent?** The memory tools are registered only when the daemon was started with memory enabled (the `ctx.memory` service). If they are missing, run `noir init` and start the daemon. To forget something recalled here, see `noir-remember`'s forget path.
