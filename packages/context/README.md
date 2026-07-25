# @noir-ai/context

Hybrid retrieval engine: a local in-process embedder (384-dim, L2-normalized) with opt-in remote/Ollama providers, a markdown/line-token chunker, a SHA-256 incremental indexer, and BM25 ∪ vector kNN → Reciprocal Rank Fusion → token-budget fill with windowed snippets (never truncated). Exposes `context_search` / `context_index` / `context_status`.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/context
```

> Most users install the CLI instead, which reaches this engine via `noir context {search,index,status}`:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
