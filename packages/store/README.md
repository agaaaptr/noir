# @noir-ai/store

Embedded storage for Noir: `better-sqlite3` + FTS5 (BM25 ranking with window snippets) + `sqlite-vec` (384-dimensional vector kNN). The daemon owns the single write handle; a read-only filesystem fallback covers the daemon-down case. The `ProjectId`-keyed database lives at `.noir/store/<projectId>.db`.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/store
```

> Most users install the CLI instead, which pulls in the packages it needs:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
