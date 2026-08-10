---
name: noir-frontend
description: Use when building or modifying frontend code — distinctive visual design, typography, component patterns, and responsive layouts. Do NOT use for pure backend logic.
metadata:
  category: domain
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - ui-patterns.md
---

# noir-frontend

Frontend design and implementation guide — visual design, component architecture, responsive patterns, and interaction behavior. Use when the user is building or reshaping UI.

## When to use

- Building or modifying a UI component, page, or layout.
- The user says "design this", "style this", "make it look good."
- A component needs consistent visual language (colors, spacing, typography, dark/light theme).

## Procedure

1. **Establish the design system.** Colors, spacing, typography, breakpoints — before any component. If the project has a design system (Tailwind config, theme tokens, CSS variables), use it; if not, suggest one.
2. **Component-first thinking.** Break the UI into independent, composable components. One component = one file = one responsibility.
3. **Responsive by default.** Start with mobile layout, add breakpoints for wider viewports. `max-width: 100%` on images; horizontal-scroll containers for wide tables.
4. **Accessibility.** Semantic HTML, keyboard navigation, color contrast, screen-reader labels. An inaccessible UI is an unfinished UI.
5. **On Claude Code**, use `AskUserQuestion` for design choices (color palette, layout preference). On other hosts, ask plainly.

## When done → next skill

→ `noir-verifying` to confirm the UI meets the spec. Or `noir-test-driven-development` to add tests.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
