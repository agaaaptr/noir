---
name: noir-dataviz
description: Use when the user asks for a chart, graph, plot, dashboard, or any data visualization — pick the chart form before the palette, apply the four color jobs and the legibility floors, then set mark sizes and ship a text alternative for every chart. Do NOT use for general UI design (noir-design) or picking a visual style (noir-design-reference).
metadata:
  category: domain
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-dataviz

A chart reads as one system when its parts are chosen in a fixed order: form first, color last, marks between. Color is the last decision, not the first, because a chart that works in grayscale still works, and a chart that leans on color alone falls apart the moment the hue is removed.

## When to use

- The user asks for a chart, graph, plot, dashboard, or any data visualization, in any medium (HTML, SVG, matplotlib, plotly, d3, or a rendered image).
- A screen needs a stat tile, sparkline, heatmap, legend, axis, or tooltip, and no chart standard is set.
- The question is about chart colors, series palettes, or how many colors a chart needs.
- Do NOT use for general UI layout, styling, or screen design. noir-design owns those.
- Do NOT use for picking an aesthetic, a style, or the token schema. noir-design-reference owns those.

## Procedure

1. Pick the chart form first, before any color. Match the data shape to a form and write the form down:
   - Compare categories → bar chart.
   - Show change over time → line chart.
   - Show parts of a whole → stacked bar or donut.
   - Show how values are distributed → histogram.
   - Show the relationship between two measures → scatter plot.
   A palette must not drive this choice; the data shape does.

2. Pick the one color job that matches the data. There are four, and each encodes a different relationship:
   - Categorical: distinct hues, equal lightness, and a fixed order the whole chart family reuses. No series may read as more important than another.
   - Ordinal: one hue ramped from light to dark in steps, so rank reads as lightness.
   - Sequential: one hue stepped from its 100 to its 700, where a larger value is a darker step.
   - Diverging: two hues that meet at a neutral midpoint; the midpoint is the meaningful center (zero, the mean, a threshold), and both sides darken away from it.

3. Check the legibility floors before rendering. Each pair of series colors needs enough separation to read as different data: hold at least a delta-E of 15 between any two series, and at least 3:1 luminance contrast between any data element and its background (text stays at 4.5:1). Keep the separation color-vision-safe: never let red versus green be the only difference between two series — add a shape, dash, label, or lightness step instead.

4. Set the mark grammar. Minimums keep marks visible and clickable at any size:
   - Bars: at least 8 px wide, with a gap smaller than the bar itself.
   - Lines: at least 2 px of weight so a line reads as data, not a hairline.
   - Markers: at least 8 px across so a point stays visible and hittable.
   - Gridlines: light and behind the data, never competing with it.
   - Axes: hairline weight in a muted color; the frame supports the data, it does not star.

5. Add the accessibility twin. Every chart ships a table or a text alternative that carries the same numbers, so the chart stays useful when the image is not there. Never let color be the only signal: pair every color with a label, shape, or pattern so the chart still reads in grayscale.

For example, a monthly revenue chart maps time to a line, uses a single hue ramped light to dark, adds a table of the same twelve numbers under the SVG, and relies on the line and its point markers, not its hue, to carry the trend.

## Verification

- [ ] The form is chosen and written down before any color decision.
- [ ] The color job is named and matches the data relationship (one of the four).
- [ ] Series colors clear a delta-E of 15 and 3:1 contrast against the background.
- [ ] Red versus green is never the only separator between two series.
- [ ] Bars, lines, and markers meet their minimum sizes; gridlines are light; axes are hairlines.
- [ ] Every chart has a table or text alternative, and no signal rests on color alone.

## Notes

- A form chosen first survives a palette change; a palette chosen first does not survive a form change.
- Reuse the project's existing palette before inventing a parallel one.
- In dark mode, keep the same four jobs but re-derive the light-to-dark direction so the contrast floors still hold.

## When done → next skill

→ noir-design for general UI layout and styling. → noir-design-reference for a style or palette lookup.
