---
name: noir-design
description: Use when the user says "design this", "style this", "make it look good", or "frontend design" — commit to one bold aesthetic, run the anti-template checks, and resolve the precedence ladder before any styling code. Do NOT use for token system mechanics (noir-design-reference) or charts and data visualization (noir-dataviz).
metadata:
  category: domain
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-design

Set one committed aesthetic before any styling code, and spend the boldness in a single place. A page that is half brutalist and half glassy reads as unsure; a page that is one thing, done deliberately, reads as designed.

## When to use

- The user says "design this", "style this", "make it look good", or "frontend design".
- A UI brief is vague and needs a direction before anyone writes CSS.
- An existing screen looks like a template and needs a distinct point of view.
- Do NOT use for token system mechanics, the style inventory, or the palette schema. noir-design-reference owns those.
- Do NOT use for charts, graphs, or data visualization. noir-dataviz owns those.

## Procedure

1. Commit to one bold aesthetic. Pick a single style from noir-design-reference (neobrutalism, editorial, glassmorphism, and the rest) and carry it through every decision. Spend the boldness once, on an oversized headline or one saturated accent, and keep everything else quiet so that one moment lands.
2. Run the anti-template check. Reject a design that leans on these ready-made tells:
   - The cream background with terracotta accents, the near-black with acid-green pairing, and every other two-color recipe that shows up unchanged across AI output.
   - A small tracked ALL-CAPS eyebrow above every headline.
   - The generic card: a soft drop shadow, a hairline border, and content floating in it with no structural reason.
   - Monospace type used as decoration on labels that are not code.
   - A call-to-action label that trails an arrow character, repeated on every link.
   These are not wrong because they are common; they are wrong because they read as unexamined. If one earns its place, keep it and say why.
3. Resolve the precedence ladder, in this order: the user's instruction and brand guide first, the project's existing design system second, the accessibility floor third, and the brief's own suggestions last. When two levels conflict, the higher one wins.
4. First pass: define tokens before code. Name the colors, spacing, radius, and type scale as variables before writing a component. Reuse the project's existing tokens when they exist; do not invent a parallel system. For example, a landing page might commit to editorial type with one oversized headline, and keep every other element quiet. noir-design-reference carries the 16-token semantic palette when no system exists.
5. Build component-first, responsive by default, and accessible. One component, one file, one job. Mobile layout first, wider breakpoints after. Semantic elements, keyboard reachability, a visible focus indicator, and a label on every input.
6. Second pass: review against the brief. Read the original request again and check that every visible choice answers it. Cut anything that exists only because it looked good.

## Verification

- [ ] One aesthetic is named and carried through every screen.
- [ ] The anti-template list was checked, and any surviving cliché has a stated reason.
- [ ] The precedence ladder was applied top-down with conflicts resolved in order.
- [ ] Tokens are defined before components, reusing the project's system when it exists.
- [ ] Every interactive element is keyboard-reachable and labeled; text meets WCAG AA contrast.

## Notes

- Boldness is a budget, not a default. One strong choice per screen is enough; two competing choices cancel out.
- When a design system already exists, follow it. This skill directs the aesthetic, not the token plumbing.

## When done → next skill

→ noir-design-reference when a style name, palette, or font pairing needs looking up. → noir-verifying when the UI must be checked against the spec.
