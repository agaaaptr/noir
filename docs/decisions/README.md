# Architecture Decision Records

ADRs record *why* a choice was made — not *what* the code does (the skills themselves show that). Capture decisions a future reader (human or agent) would otherwise have to reverse-engineer.

## Format

- Filename: `NNNN-<short-slug>.md` (zero-padded, e.g. `0001-commit-per-scope.md`).
- Append-only: never delete a superseded ADR — mark it **Status: Superseded by ADR-NNNN** and add the new one.
- Sections: *Context*, *Decision*, *Consequences*.

## Index

- [ADR-0001 — Documentation layout and spec/plan paths](0001-doc-layout-and-spec-plan-paths.md)
- [ADR-0002 — Native skills only — plugin + marketplace removed](0002-native-skills-only-plugin-removed.md)
- [ADR-0003 — v1.x capabilities — keystone refactor + five extensions](0003-v1x-capabilities.md)
- [ADR-0004 — Multi-host adapters — the `resolveAdapter(host)` registry + AGENTS.md universal](0004-multi-host-adapters.md)
