# @noir-ai/daemon

The runtime authority: owns the store write handle, resolves the embedder once, and exposes the single Noir MCP server (stdio + Streamable HTTP). Store-touching CLI commands are MCP clients to this daemon; a read-only filesystem fallback covers the daemon-down case.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/daemon
```

> Most users install the CLI instead, which manages the daemon lifecycle (`noir daemon start|stop|status`):
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
