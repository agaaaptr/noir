---
name: noir-context
description: Use when a question spans more files than fit in context — query Noir's hybrid retrieval index (BM25 + kNN) for windowed snippets. Use when the user says "index this", "search the codebase", or "find where X is used". Do NOT use for a single-file lookup.
metadata:
  category: context
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-context

Hybrid retrieval for large codebases — index once, query many times. The host gets windowed snippets (BM25 + kNN → RRF) instead of re-reading entire files. Local 384-dim embeddings by default, zero API key.

## When to use

- A question spans more files than fit in context.
- The user says "search the codebase", "find where X is", "index the repo."
- You need cross-referenced snippets from many files for a single answer.
- **Do NOT use:** for a single-file read — just Read it.

## Procedure

1. **Index the repo.** `noir context index` (one-time; `--force` to reindex). This seeds BM25 + embeddings into the store.
2. **Query with specific terms.** `noir context search "<query>"` returns windowed snippets around matches. Use terms you'd grep for — function names, error messages, patterns.
3. **Consume the snippets.** The output is the evidence. Don't re-read the whole file unless a snippet implicates it.
4. **Repeat as needed.** New queries are cheap — the index is persistent.

## Notes

- The index is a cache, not a replacement for reading files. Snippets show WHERE; reading shows CONTEXT.
- `noir context index --force` rebuilds from scratch (good after large changes).
- Zero API key required for local embeddings; remote/Ollama embedders are opt-in.

## When done → next skill

The snippets should answer your question. If not, try a more specific query, or read the implicated file directly.
