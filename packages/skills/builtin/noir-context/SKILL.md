---
name: noir-context
description: Use when a question spans more files than fit in context — to seed the repo into a hybrid index once, then query it for windowed snippets instead of reading whole files.
---

Ground a question in the whole repo without pulling every file into context. Seed the index once with `context_index`, then query it with `context_search` and reason over the returned windowed snippets. Snippets are extracted around each match and never truncated, so the surrounding line context is intact without a whole-file read.

## Procedure
1. **Seed the index.** Call `context_index { paths: ["src", "docs"] }` with the trees you need grounded, or omit `paths` to index the project root. Indexing is incremental by SHA-256 content-hash — unchanged files are skipped, so re-call it freely after edits. It must run once before `context_search` returns anything useful.
2. **Query, do not dump.** Call `context_search { query, budgetTokens }` with a natural-language or identifier query (e.g. `"ContextEngine"` or `"where are errors thrown"`). Set `budgetTokens` to what you can spare (default 4096); optionally pass `source` to scope both legs to one bucket such as `"docs"` or `"codebase"`. You get ranked hits — path, a windowed snippet, a score — fused from BM25 and vector similarity, not raw file dumps.
3. **Reason over the snippets.** Read the returned windows and decide; open a file by path only when a snippet implicates a change. Everything else stays a citation.
4. **Re-seed when stale.** After non-trivial edits, re-run `context_index` so the index reflects current content. The content-hash skip keeps it cheap; staleness is the only way a snippet drifts from the code on disk.

## Notes
- **Degraded is honest, not broken.** With no embedder configured (or the local model failed to load), `context_search` still works in BM25-only mode and returns `degraded: true, mode: "bm25-only"` — lexical recall with no semantic leg. A read-only store (daemon down) still serves `context_search` and `context_status`; only `context_index` is fenced off, returning a clear `ok: false, degraded: true` envelope rather than failing mid-write.
- **Check health first when unsure.** `context_status` reports `docCount`, `vecCount`, `indexedFiles`, the active embedder (`kind` / `model` / `dim`), and the persistent `degraded` flag — read it once to know whether the index is populated and whether to expect vectors.
- **Tools absent?** The three tools are registered only when the daemon was started with context enabled (the `ctx.context` service). If they are missing, run `noir init` and start the daemon before reaching for this skill.
- Keep raw search output out of context where the tool already did the windowing; reach for whole-file reads only for the few files you will actually edit (see `noir-explore`). This skill grounds a query in indexed content — it does not review or refactor what it finds; hand to `noir-review` for judgment.
