# a2ui-svelte minimal example

Smoke-test consumer for the `a2ui-svelte` library. Demonstrates every
public API in three pages.

## Run

```bash
# from the repo root
pnpm install
GEMINI_API_KEY=your-key-here pnpm --filter minimal-app dev
```

Open http://localhost:5173.

## Routes

- `/` — **Static surface.** UI you lay out by hand in Svelte; A2UI makes
  it legible to the agent. Shows all 16 standard components. Try: "set
  name to Alice, rating to 9, and click Submit". Or ask it to *point
  something out* — "where do I submit?" / "show me the rating" — and the
  agent glows + scrolls the target into view (the `point_to_elements`
  extension), without changing anything.
- `/canvas` — **Dynamic surface.** An empty `<DynamicSurface>` the agent
  fills in itself at runtime from a component catalog. Try: "render a
  card with a yes button and a no button".
- `/custom-elements` — **Custom elements.** How to build widgets the
  16-component catalog lacks. Demonstrates the *composite* pattern: a
  `StarRating` that the agent sees as a plain `MultipleChoice` (via
  `<A2UIRepresentation>`) while the user sees clickable stars. Try:
  "give it four stars".

## What this app demonstrates

- Subpath imports: `a2ui-svelte/renderer`, `a2ui-svelte/components`,
  `a2ui-svelte/authoring`, `a2ui-svelte/voice`, `a2ui-svelte/voice/gemini`.
- The `session.svelte.ts` pattern for publishing surfaces to the
  layout-level `<VoiceShell>`.
- The `SurfaceFeedback` context for tool-result reporting.
- The on-demand `point_to_elements` highlight extension (default-on) —
  ask the agent to point something out and it glows + scrolls into view.
- CSS variable theming (see `app.css` for indigo override of
  `--a2ui-button-primary-bg`).
- The `<A2UIRepresentation>` boundary in `lib/StarRating.svelte`.
