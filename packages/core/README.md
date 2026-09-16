# @noir-ai/core

Shared domain types, the configuration schema (`NoirConfigSchema`), the `.noir/` on-disk layout, and the marker constants that the rest of the Noir toolkit is built on — plus the shared on-disk helpers those types are enforced through (the managed-block writer, the `.noir/.env` loader, the gitignore manager, and the git-tracked check).

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/core
```

> Most users install the CLI instead, which pulls in the packages it needs:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

This package is mainly consumed by the other `@noir-ai/*` packages. For programmatic usage, see the [root README](https://github.com/agaaaptr/noir#readme) and [`docs/reference/cli.md`](https://github.com/agaaaptr/noir/blob/main/docs/reference/cli.md).

## License

MIT © agaaaptr
