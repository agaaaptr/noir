# @noir-ai/skills

The native `noir-*` skill pack (26 builtins plus 1 integration) and a copy-and-validate compiler. `noir init` / `noir sync` emit it idempotently for hosts with a skill surface: Claude uses `.claude/skills/`; Cursor uses `.cursor/rules/*.mdc`. There is no plugin or marketplace.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/skills@beta
```

> Most users install the CLI instead, which emits the builtin skills via `noir init` / `noir sync`:
>
> ```bash
> npm install -g @noir-ai/cli@beta
> ```

## License

MIT © agaaaptr
