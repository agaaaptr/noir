# UI patterns — design system, components, accessibility

Deep reference for `noir-frontend`. Practical patterns for building and reshaping UI that reads as one coherent system.

## Establish the design tokens first

A UI is coherent when it draws from ONE set of tokens. Before styling a component, confirm or propose:

- **Color** — a small palette: background, surface, text-primary, text-muted, accent, error. Light + dark variants. Never 20 ad-hoc hex values.
- **Spacing** — a scale (e.g. 4/8/12/16/24/32). Use the scale, not arbitrary pixels.
- **Typography** — font stack, size scale (e.g. xs/sm/base/lg/xl/2xl), line-height, weight for headings vs body.
- **Radius/shadow** — a consistent corner radius and elevation system.
- **Breakpoints** — the widths where layout changes (e.g. 640/768/1024/1280).

Where the project already has tokens (Tailwind config, CSS variables, a theme file), USE THEM — do not invent a parallel system.

## Component-first structure

- One component = one file = one responsibility. A `Button`, a `Card`, a `TableRow` — each standalone.
- Components are composable: small pieces assemble into screens.
- Props/inputs are explicit; a component never reaches into global state it wasn't given.

## Responsive by default

- **Mobile-first** — build the narrow layout first, add breakpoints for wider views.
- `max-width: 100%` on images and media — never overflow.
- Wide tables and code blocks scroll inside their OWN container (`overflow-x: auto`) — the page body never scrolls horizontally.
- Touch targets ≥ 44px on interactive elements.

## Accessibility (non-negotiable)

- **Semantic HTML** — use `<button>`, `<a>`, `<nav>`, `<label>`, not `<div onClick>`.
- **Keyboard** — every interactive element reachable + operable by keyboard (focus, Enter/Space).
- **Focus** — a visible focus indicator; never `outline: none` without a replacement.
- **Contrast** — text meets WCAG AA contrast against its background (both themes).
- **Labels** — every input has a `<label>` or `aria-label`; images have alt text.
- **Reduced motion** — respect `prefers-reduced-motion`.

## Interaction behavior

- **State** — every interactive element has hover / focus / active / disabled / loading states.
- **Feedback** — actions give feedback (a spinner, a toast, a state change). Silent failure confuses users.
- **Optimistic updates** with rollback on error feel faster than blocking on every request.

## Good / bad

Good: a component uses the spacing scale, tokens, semantic markup, and has all states.
Bad: a hard-coded `padding: 17px`, an inline `#f3f2ef` that exists nowhere in tokens, a `<div onClick>` for a button, no focus style, an image with no alt.
