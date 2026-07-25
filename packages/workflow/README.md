# @noir-ai/workflow

The spec-driven development lifecycle engine: a hand-rolled finite-state machine (Intake → Clarify → Spec → Plan → Execute → Verify → Document) with observable, escapable gates. Every decision is recorded; phases can be force-skipped with a reason or jumped to directly. Supports Full, Quick, and Resume modes with cross-session resume.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/workflow
```

> Most users install the CLI instead, which pulls in the packages it needs:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
