# @noir-ai/adapters

The host abstraction (`HostAdapter`) that decouples Noir from any specific agentic CLI. Noir ships five adapters through a `resolveAdapter(host)` registry: `claude`, `agents-md`, `gemini`, `cursor`, and `opencode`. They emit each host's native context and MCP artifacts; Claude and Cursor also have skill-emission surfaces.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/adapters@beta
```

> Most users install the CLI instead, which wires the host adapter via `noir init`:
>
> ```bash
> npm install -g @noir-ai/cli@beta
> ```

## License

MIT © agaaaptr
