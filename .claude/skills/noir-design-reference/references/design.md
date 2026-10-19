# Design reference — styles, tokens, rules, fonts, motion

This file is the inventory noir-design-reference consults. It holds the style taxonomy, the semantic color palette, the UX rule ladder, the font-pairing guidance, and the motion tiers. It is a reference, not a playbook: noir-design decides the direction; this file supplies the raw material for that decision.

## How to read this file

- For a named style, read its entry under the taxonomy and return era, tokens, cost, accessibility floor, and fit.
- For an open choice between styles, compare the Cost and Accessibility floor lines first, then the fit.
- For color, copy the 16-token palette and fill it with the chosen style's colors.
- For any other rule, find the rung or tier that matches and quote it.

Cost is the effort to build the style well and keep it accessible. Low means a day of CSS. Medium means several days with fallbacks. High means bespoke assets or platform-specific work.

## Style taxonomy

Fourteen styles. Each entry names the era, the signature in one line, the tokens that carry it, the cost, the accessibility floor, and when it earns its place.

### neobrutalism

**Era**: 1990s web revival, popular again from 2020.
**Signature**: flat blocks with thick borders and hard offset shadows; the layout owns its grid.
**Tokens**: saturated primaries on off-white or near-black; radius 0; hard shadow with no blur (4px 4px 0); a 2px to 4px solid border, often black; bold grotesque display type.
**Cost**: low to medium. The borders and shadows are cheap CSS; the real work is restraint, because every element shouting at once collapses the style.
**Accessibility floor**: contrast is strong by default, but pure saturated color pairs can drop below 4.5:1, so check text pairs. The offset shadow must never be the only focus indicator.
**Use**: playful, opinionated, or developer-facing products. **Avoid**: quiet, clinical, or financial surfaces.

### glassmorphism

**Era**: early 2020s frosted-panel trend.
**Signature**: translucent panels that blur what sits behind them, edged with a thin light border.
**Tokens**: semi-transparent white fill at 10 to 20 percent opacity; backdrop blur; a 1px border in a lighter tone; radius 16 to 24px; a soft diffuse shadow; light or mid-weight sans type.
**Cost**: medium to high. backdrop-filter is expensive on low-end GPUs and needs a solid fallback behind it.
**Accessibility floor**: translucency cuts text contrast, so a glass panel needs a darker scrim or a solid fallback. Never let blur carry legibility alone.
**Use**: dashboards and cards over imagery, where depth sells the hierarchy. **Avoid**: dense data tables and forms, where the blur adds cost without clarity.

### neumorphism

**Era**: 2019 soft-UI experiment.
**Signature**: elements that look extruded from the background, built from two shadows on a matching surface.
**Tokens**: background and element share one color; radius 12 to 20px; paired shadows, one light and one dark offset, with no border; low-contrast monochrome type.
**Cost**: low to build, high to keep accessible.
**Accessibility floor**: the near-identical tones give weak affordance and poor contrast, so interactive elements need a stronger hover and pressed state, and text needs 4.5:1 against its surface.
**Use**: decorative control panels and demos. **Avoid**: anything a user must operate quickly, and every form.

### claymorphism

**Era**: 2021 playful 3D-soft look.
**Signature**: puffy, rounded, toy-like surfaces with an inner top highlight and a soft outer shadow.
**Tokens**: pastel or mid-tone fills; radius 24 to 40px; a bright inner highlight near the top; a soft outer shadow; a minimal border; rounded friendly type.
**Cost**: medium. Shadow layering and gradient work add up, and each state needs its own pass.
**Accessibility floor**: pastels often fall under 4.5:1 on white, so text needs a darker ink, and interactive clay elements need a clear pressed state.
**Use**: kid-friendly products, onboarding, and empty states. **Avoid**: enterprise dashboards and data-dense screens.

### skeuomorphism

**Era**: mid-2000s realism, the era before flat design.
**Signature**: digital elements that imitate physical materials such as leather, paper, brushed metal, and glass.
**Tokens**: realistic gradients and textures; heavy inner and outer shadows; beveled borders; ornament; type that matches the object's period.
**Cost**: high. Texture and lighting assets are bespoke, and every state needs its own art.
**Accessibility floor**: texture must not sit behind text without a solid scrim, and imitation depth must not replace labels and focus states.
**Use**: niche realism where the metaphor teaches the interface, such as music gear, note apps, and games. **Avoid**: general product UI, where texture fights the content.

### minimalism

**Era**: timeless reduction with Swiss design roots.
**Signature**: the fewest elements needed, with whitespace carrying the hierarchy.
**Tokens**: one accent color on a neutral background; radius 0 to 8px; no shadow or a hairline shadow; a hairline or no border; restrained type on a strong grid.
**Cost**: low to build, high to keep disciplined.
**Accessibility floor**: low contrast is the common failure, so keep text at 4.5:1 or better, and never let whitespace be the only grouping cue a screen reader can rely on.
**Use**: editorial, documentation, and developer tools. **Avoid**: playful or child-facing products that need warmth.

### brutalism

**Era**: raw early-web ethos, revived around 2016.
**Signature**: deliberately unrefined defaults: system fonts, default link colors, and exposed structure.
**Tokens**: system type; browser-default colors; radius 0; visible table borders; no shadows; often a single flat background.
**Cost**: low to build, medium to keep readable at scale.
**Accessibility floor**: default contrast is fine, but decorative rawness must not remove focus rings or semantic structure.
**Use**: personal sites, art projects, and statements. **Avoid**: mainstream products where users expect polish.

### bento grid

**Era**: 2022 dashboard-layout trend descended from Apple-style grid tiles.
**Signature**: a packed grid of rounded tiles in varied sizes, each holding one piece of content.
**Tokens**: neutral card fills; radius 16 to 24px; a hairline border; a soft shadow; small clear labels; tight padding.
**Cost**: medium. Responsive grid sizing and fitting content into tiles both take real work.
**Accessibility floor**: keep each tile's text at 4.5:1, and keep the tab order matching the visual order.
**Use**: dashboards, landing summaries, and app home screens. **Avoid**: long-form reading, where the grid fragments the text.

### editorial

**Era**: print magazine typography carried onto the screen.
**Signature**: strong serif display type, a strict column grid, and generous whitespace.
**Tokens**: serif display with a clean sans body; off-white or paper background; near-black ink; hairline rules; radius 0; no shadows.
**Cost**: medium. The type pairing and grid discipline are the product.
**Accessibility floor**: serif display at small sizes loses legibility, so body text stays 16px or larger in a readable face at 4.5:1.
**Use**: media, culture, publishing, and portfolios. **Avoid**: dense product UI and data tools.

### luxury

**Era**: understated high-end retail aesthetic.
**Signature**: quiet, spacious, matte surfaces with a single precious accent.
**Tokens**: a deep neutral or cream background; a gold or deep accent; wide letter-spacing on small caps; hairline borders; soft or no shadow; serif display type.
**Cost**: medium to high. Photography and spacing carry the product.
**Accessibility floor**: tiny tracked caps and thin serifs fail 4.5:1, so body text needs a readable size and weight.
**Use**: fashion, jewelry, hospitality, and premium services. **Avoid**: utilities and tools where speed matters more than mood.

### cyberpunk

**Era**: 1980s neon-noir future.
**Signature**: glowing neon on dark, with scanlines and high-tech motifs.
**Tokens**: neon cyan and magenta on deep navy or black; glow shadows; thin borders; mono or tech display type; grid and scanline texture.
**Cost**: high. Glow effects, texture, and dark-mode-only maintenance all add up.
**Accessibility floor**: neon on black can bloom and blur, so keep body text bright white or add a dark scrim, and never rely on glow for focus.
**Use**: games, music, developer tools, and event sites. **Avoid**: long-form reading and anything light-mode-only.

### Y2K

**Era**: late-1990s and early-2000s nostalgia.
**Signature**: chrome, gradients, and bubbly type from the turn of the millennium.
**Tokens**: chrome and gradient fills; a pink, blue, and silver palette; glossy bevels; 3D-ish buttons; italic or bubbly display type.
**Cost**: high. Gradient and bevel art is needed for every state.
**Accessibility floor**: metallic gradients make text contrast unstable, so put labels on a flat band or scrim and keep touch targets at 44px.
**Use**: fashion, music, and nostalgia campaigns. **Avoid**: forms, dashboards, and anything with strict legibility needs.

### spatial (visionOS)

**Era**: 2023 glass-and-depth spatial computing idiom.
**Signature**: frosted glass layers that float at depth with soft light from the environment.
**Tokens**: frosted glass; subtle depth blur; rounded panels at 20 to 28px; a soft ambient shadow; system sans with generous spacing.
**Cost**: high. Depth layering and glass are platform-specific.
**Accessibility floor**: glass over busy scenes needs a scrim, text stays at 4.5:1, and depth must never be the only grouping cue.
**Use**: spatial and immersive interfaces, premium apps. **Avoid**: plain 2D web where the depth has nothing behind it.

### material / flat

**Era**: Google's 2014 layered-flat system, and the flat design it answered.
**Signature**: flat color surfaces with soft elevation, grid-aligned and geometric.
**Tokens**: a small color system; radius 4 to 8px; layered elevation shadows; no gradients; clean sans type.
**Cost**: low to medium. It is well documented and componentized.
**Accessibility floor**: elevation shadows are weak affordance, so states need more than a shadow change, and text keeps 4.5:1.
**Use**: broad product UI, admin tools, and Android-flavored apps. **Avoid**: a bold brand moment, where flat reads as default.

## The 16-token semantic palette

The schema to copy into a project that has no design system. It follows the shadcn and Tailwind naming so it drops into plain CSS variables or Tailwind's color slots. Define every token in light and dark, and never hardcode a hex inside a component.

| Token | Role | Notes |
|---|---|---|
| primary | the main brand fill | buttons, links, active states |
| on-primary | ink and icons that sit on primary | must reach 4.5:1 against primary |
| secondary | a quieter fill for hover and secondary buttons | a tone of primary or a neutral |
| on-secondary | ink and icons that sit on secondary | the same 4.5:1 rule |
| accent | the highlight used once, sparingly | the boldness budget lives here |
| on-accent | ink and icons that sit on accent | check contrast, since accent is often bright |
| background | the page background | near-white in light, near-black in dark |
| foreground | default text and icons on background | 4.5:1 against background |
| card | fill for cards and panels | one step off background |
| card-foreground | text and icons that sit on card | 4.5:1 against card |
| muted | a faint fill for hints and disabled areas | never used for body text |
| muted-foreground | secondary text on background or card | 4.5:1 for meaningful text |
| border | hairline rules and input borders | 3:1 against adjacent fills for component boundaries |
| destructive | the danger fill | buttons that delete or warn |
| on-destructive | ink and icons that sit on destructive | usually white |
| ring | the focus ring color | must stand out from background and primary |

An on- token always names the ink that sits on its base token. Keep the list at exactly these 16; a color that appears in one component and nowhere else does not earn a token.

## The UX rule ladder

Check in this order. Each rung outranks the one below it, so a style that fails a higher rung is dropped no matter how it looks.

1. **Accessibility.** 4.5:1 contrast for normal text and 3:1 for large text and component boundaries; every interactive element keyboard-reachable; a visible focus indicator; a label or aria-label on every input; alt text on images. This rung is non-negotiable and comes first.
2. **Touch and interaction.** 44 by 44px targets with space between them; hover, focus, active, and disabled states on every control; pressed feedback so the user knows the tap registered.
3. **Performance.** Images sized to their slot and lazy-loaded off-screen; fonts subset or variable; no layout shift from late-loading media; a first paint fast enough that nothing blocks interaction.
4. **Style selection.** Commit to one aesthetic, as noir-design directs. A style that cannot hold the three rungs above is disqualified.
5. **Layout and responsive.** Mobile first, widening at breakpoints; an 8px spacing grid so every gap is a step of 8; no horizontal page scroll.
6. **Typography and color.** 16px minimum body text; a type scale with clear steps; one accent used sparingly; text never sits directly on a busy texture or image.
7. **Animation.** 150 to 250ms transitions with one purpose each; transform and opacity only; no motion that delays the task.
8. **Forms and feedback.** A label on every field; errors next to the field they name; empty, loading, error, and success states all present.
9. **Navigation.** Predictable placement; a visible current state; keyboard operable; no links that lead nowhere.
10. **Charts and data.** noir-dataviz owns the detail; the floor is a colorblind-safe palette and labelled axes.

## Font pairing

- Two families at most: one display face and one body face. Three is a poster, not an interface.
- The pairing needs contrast in one dimension: a serif display with a neutral sans body, a grotesque display with its own light cut for body, or one variable family with clear weight and size steps.
- Body text stays at 16px or larger with a line-height near 1.5; the display face is for headings only.
- A mono face may join for code and data only, never for paragraphs.
- Pairs that work: a high-contrast serif display with a neutral grotesque body; a geometric sans display with the same family's regular cut for body; an editorial serif display with a humanist sans body.

## Motion tiers and reduced motion

Pick one tier and keep the whole product in it.

- **None.** Static. For forms, data tools, and anything the user must read carefully.
- **Subtle.** 150 to 250ms ease-out transitions on hover and focus, with short fades and slides for appearing content. The default for most product UI.
- **Expressive.** Longer keyframed sequences for heroes and onboarding, with a clear narrative reason to exist.

Every tier wraps behind prefers-reduced-motion: a user who asks for reduced motion gets the None tier regardless of the product's choice. Never animate layout properties that force reflow; transform and opacity are the safe pair.
