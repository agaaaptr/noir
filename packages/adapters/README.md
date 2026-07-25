# @noir-ai/adapters

The host abstraction (`HostAdapter`) that decouples Noir from any specific agentic CLI. v1 ships the Claude Code adapter (`.mcp.json` wiring, `CLAUDE.md` `@import`, and `.claude/skills/` emission). Additional hosts arrive in later slices via a `resolveAdapter(host)` registry.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/adapters
```

> Most users install the CLI instead, which wires the host adapter via `noir init`:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
