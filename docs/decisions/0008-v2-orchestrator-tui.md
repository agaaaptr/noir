# ADR-0008: v2 orchestrator TUI — single-surface consolidation + `noir run` headless host-driving

- **Status:** Accepted
- **Date:** 2026-08-14
- **Supersedes the deferred scope of:** ADR-0006 §6

## Context

ADR-0006 §6 deferred the "v2 orchestrator TUI" (Archetype B) as *spawn the host CLI, render its `stream-json`, token/cost status bar, mouse, fullscreen alternate-screen, transcript mode*. When that work started (2026-08-14), two independent findings changed the shape:

1. **Surface redundancy (user-observed).** The v1 TUI exposed six surfaces — dashboard, command palette (`Ctrl+K`), curated home menu (`h`), static help (`?`), output search (`Ctrl+F`), destructive confirm — with overlapping interaction shells (two arrow-key lists with a copy-pasted footer hint, three free-text input rows, two "recently run" stores, a confirm gate that covered palette/home but not typed `/command`).
2. **Form-factor reversal (research).** The 2025–26 AI-CLI landscape deliberately rejects fullscreen alternate-screen TUIs in favor of writing to the normal terminal buffer (Claude Code, goose, aider, zed, cursor all do this; koda's competitive analysis found *"no terminal-based AI agent uses a fullscreen TUI framework"*). Ink's alternate-screen path is experimental (buffer-exit artifacts, no dynamic toggle — Gemini CLI #22869).

## Decision

1. **Collapse command discovery to ONE surface.** Home, help, and output search fold into the command palette (`Ctrl+K`), which gains three corpora switched with `Tab`: `commands`, `output`, `help`. `h`/`?`/`Ctrl+F` open the same surface at a corpus. The `Mode` union collapses to `dashboard | palette{corpus} | confirm`, and keyboard routing is unified in the App's single `useInput` (the palette is presentational).
2. **Deliver the orchestrator as `noir run <prompt>`** (programmatic host-driving — the roadmap v2.0 line), not a fullscreen subprocess view. It spawns the host headless, consumes its `stream-json`, and reports token/cost — **without** running Noir's own model+tool loop (D5 preserved).
3. **Custom host command (D2a).** `--command <binary>` overrides the per-host default so users with multiple profiles (`claude` vs `claude-work`) can point at their own binary; applies to every host adapter.
4. **Token/cost correctness.** A `UsageReducer` applies the `max usage per message.id` rule (Claude emits one cumulative JSONL line per content block; summing over-counts ~2.5-3x).
5. **Unified recents + full confirm coverage.** One persisted recents source feeds both shell recall and the palette; a destructive typed `/command` routes through the same `y/N` gate as palette selections.
6. **Drop fullscreen alternate-screen + native mouse** from the shipped scope — the normal-buffer hybrid is the default; fullscreen/mouse are tracked but not shipped (research §2).

## Consequences

**Positive.** Command discovery is one predictable surface; the orchestrator is a scriptable, offline-testable CLI command (the pure core — host resolution, event normalization, usage reduction — is unit-tested without a live host); token/cost is numerically correct; users with multiple host profiles can select their binary.

**Trade-offs / risks.** The fullscreen alternate-screen + native-mouse vision of ADR-0006 §6 is explicitly **not** delivered (research shows the ecosystem moving away from it; revisit only if demand surfaces). `noir run`'s non-claude host flags (`gemini`/`opencode`/`cursor`) are best-effort defaults, not verified third-party contracts — the custom-command path is the escape hatch. The `run` command leaves the `agents-md` host unsupported (it is a file emitter, not a spawnable CLI).

**Deferred (tracked, not lost).** Fullscreen alternate-screen + mouse (§6 here); a full TUI session/transcript picker over the persisted transcript (the `noir run` transcript file is the source of truth; a browser UI is future work); memory cloud sync / team / skill registry (v2.0 ecosystem, `releases.md`).
