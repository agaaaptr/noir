# @noir-ai/model

An optional, bounded model layer — single-shot completion only, provider-explicit, that null-degrades cleanly without a key. Backed by three dynamically imported adapters (Anthropic, OpenAI, and OpenAI-compatible via `fetch` for Ollama / LM Studio / vLLM). Agent loops are impossible by design: no `tools` or `stream` parameters exist on the request.

Part of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit — the discipline, context, and memory layer for any agentic CLI.

## Install

```bash
npm install @noir-ai/model
```

> Most users install the CLI instead, which configures providers via `noir init` / `noir doctor`:
>
> ```bash
> npm install -g @noir-ai/cli
> ```

## License

MIT © agaaaptr
