---
name: ui-ux-pro-max
description: UI/UX design intelligence for building beautiful, production-grade web apps. Provides a live searchable design database — 161 color palettes, 57 font pairings, 50+ visual styles, 99 UX guidelines, chart guidance, and per-stack (React/Next/Vue/Svelte/HTML-Tailwind/shadcn/Flutter/SwiftUI…) best practices — queried on demand via the ui_search tool. Use for ANY website, landing page, dashboard, SaaS, portfolio, e-commerce, or app UI request.
metadata:
  domain: frontend
  triggers: ui, ux, design, website, landing page, dashboard, saas, portfolio, app, frontend, css, tailwind, palette, color, colours, font, typography, style, glassmorphism, neumorphism, brutalism, dark mode, responsive, component, layout, chart, accessibility, hero, pricing, marketing
---

# UI/UX Pro Max — Design Intelligence (via the `ui_search` tool)

You are building a real, polished product UI. Instead of guessing palettes and
fonts, you have a **live design database** you can query mid-response with the
`ui_search` tool. ENZO runs the search and injects the results back into your
context, then your reply continues seamlessly — the tag never reaches the user.

## How to call it

Emit this tag anywhere in your reply. You may fire several at once:

```
<ui_search domain="color">fintech banking dashboard, trustworthy, dark</ui_search>
<ui_search domain="typography">modern SaaS, geometric, professional</ui_search>
<ui_search domain="style">glassmorphism landing page</ui_search>
<ui_search stack="react">form validation and accessible inputs</ui_search>
```

After you emit them, STOP and wait — the results arrive as
`[UI/UX SEARCH RESULTS …]` in context. Then design using the exact hex values,
font families, CSS import URLs, and rules returned. Do not invent palettes when
the database has one.

## When to search (do this at the START of any UI build)

Before writing CSS, run 2–4 lookups to lock the design system:
1. `domain="color"` — the palette for this product type (returns full semantic
   tokens: Primary, Accent, Background, Card, Muted, Border, Destructive, …).
2. `domain="typography"` — a font pairing (returns Heading + Body font, the
   Google Fonts `<link>`/CSS import, and Tailwind config).
3. `domain="style"` — the visual style's effects, implementation checklist, and
   design-system variables.
4. `domain="product"` or `domain="landing"` — section order & layout pattern.

Then, while building, search as needed:
- `domain="ux"` — usability/accessibility rules for a component (touch targets,
  focus states, form errors) with good/bad code examples.
- `domain="chart"` — the right chart type for a data shape.
- `domain="icons"` — icon library + import code.
- `stack="<name>"` — framework-specific guidelines and perf rules. Stacks:
  react, nextjs, vue, svelte, astro, swiftui, react-native, flutter, nuxtjs,
  nuxt-ui, html-tailwind, shadcn, jetpack-compose, threejs, angular, laravel.

Domains: `color`, `typography`, `style`, `product`, `landing`, `ux`, `chart`,
`icons`, `google-fonts`, `react`, `web`. Omit `domain` to auto-detect from the
query.

## Rules

- Query with descriptive phrases (product type + mood + constraints), not single
  words — BM25 ranks on overlap. "minimal dark crypto dashboard, high contrast"
  beats "dashboard".
- Apply results literally: use the returned hex tokens as your CSS custom
  properties, the returned font import verbatim, the returned checklist as your
  build list.
- One good search per concern is enough — don't spam identical queries.
- This is a design aid, not a substitute for the build. After searching, ship
  the complete polished multi-file project per CODING MODE rules.
