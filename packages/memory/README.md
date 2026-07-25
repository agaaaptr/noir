# @noir-ai/memory

Cross-session memory layered on top of the store — `save` / `recall` / `search` / `sessions` / `forget` / `consolidate` — with full governance (audit trail, delete-with-reason, export). Recall reuses the context engine's hybrid retrieval (BM25 + vector kNN + Reciprocal Rank Fusion); consolidation is opt-in and provider-gated, refusing cleanly without a provider.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/memory
```

> Most users install the CLI instead, which reaches memory via `noir memory {recall,save,sessions,forget,consolidate}`:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
