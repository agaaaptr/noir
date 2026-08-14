# MCP Tools Reference

> Auto-generated from daemon tool registrations.

### General

| Tool | Description |
|---|---|
| `host_status` | Report Noir |
| `store_status` | Report the Noir embedded store |
| `workflow_status` | Report the active Noir spec-driven task |
| `checkpoint` | Checkpoint a Noir spec-driven task: `save` flushes the in-flight state to the store KV; `restore` reads it back. Omit taskId to target the active task. |
| `workflow_start` | Start a Noir spec-driven task at draft/intake and make it the active task (workflow:active). Re-starting an existing taskId overwrites it (the KV is the source of truth, not a journal). Defaults to full mode. taskClass (feature/epic/…) drives the soft PRD gate at the spec gate; quick mode writes a stub spec + fast-forwards to executing. |
| `workflow_advance` | Advance a Noir spec-driven task to its next phase, or jump with `to`. At a gate-landing state (entering specified/planned/done) a gate is recorded — approved by default, forced (with reason) via `force`, or skipped via `skip`. Omit taskId to target the active task. `force` and `skip` are mutually exclusive. For an evidence-backed verify gate, supply `evidence` (ranAt + checks[]). |
| `workflow_resume` | Resume a Noir spec-driven task across a session break. Omit taskId to target the active task. Blocked/in-flight tasks are resumable; done/abandoned are terminal. Returns the task status + a resumable flag. |
| `workflow_block` | Mark a Noir spec-driven task blocked with a reason. Omit taskId to target the active task. A blocked task is resumable (retains FSM edges to every in-flight phase). |
| `workflow_abandon` | Abandon a Noir spec-driven task (terminal). Omit taskId to target the active task. Abandonment is irreversible for the task lifecycle. |
| `workflow_research_record` | Record a research finding for a Noir spec-driven task (append-only to research:<taskId>). Non-grounding-fact types require a source (defeats faux context). |
| `context_search` | Hybrid search over the Noir context index: BM25 ∪ cosine-kNN fused by Reciprocal Rank Fusion (k=60), packed into a token budget with window-extracted snippets (never truncated). Returns ranked hits with path, snippet, and score. |
| `context_index` | Incrementally index files/directories into the Noir context store (SHA-256 content-hash; unchanged files are skipped). Indexes docs + 384-dim vectors into the existing tables (no schema migration). Omit paths to index the project root. |
| `context_status` | Report the Noir context index |
| `memory_save` | Persist a cross-session memory observation (pattern / preference / architecture / bug / workflow / fact / decision). Stored locally on top of the Noir store (FTS5 + vectors + KV) — never truncated, never sent to an LLM. Returns the full saved observation. |
| `memory_recall` | Hybrid recall over cross-session memory: BM25 ∪ cosine-kNN fused by Reciprocal Rank Fusion (k=60) scoped to source: |
| `memory_search` | Instant BM25-only lookup over cross-session memory (no embedding cost). Returns ranked observations with FULL content, scoped to source: |
| `memory_sessions` | List per-session memory rollups (session id, observation count, most-recent timestamp) for this project |
| `memory_forget` | Remove observations from cross-session memory: deletes the authoritative KV row + best-effort FTS/vector purge. Returns the count actually removed. |
| `memory_consolidate` | Explicitly consolidate recent memory observations into ONE derived lesson (append-only; originals are never mutated). Provider-gated: refuses + logs if no provider is configured — NEVER a silent paid call. Emits a type: |
| `integrations_auth` | Resolve an integration token VALUE server-side at call time (kills the non-interactive-shell gotcha). Pass {integration: |
| `noir_clickup_write` | — |
