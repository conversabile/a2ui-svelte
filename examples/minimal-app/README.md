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

- `/` — **Static surface.** Card → Column with a TextField and a primary
  Button. Try: "fill in the name with Ada and click save".
- `/canvas` — **Dynamic surface.** Empty `<DynamicSurface>`. Try: "render
  a card with a yes button and a no button".
- `/composite` — **Composite component.** Uses `<A2UIRepresentation>`
  via `SaveTextField`. Try: "type 'hello' and click save". The agent
  sees a Column→[TextField, Button] and updates value through the
  bespoke HTML.

## What this app demonstrates

- Subpath imports: `a2ui-svelte/renderer`, `a2ui-svelte/components`,
  `a2ui-svelte/authoring`, `a2ui-svelte/voice`, `a2ui-svelte/voice/gemini`.
- The `session.svelte.ts` pattern for publishing surfaces to the
  layout-level `<VoiceShell>`.
- The `SurfaceFeedback` context for tool-result reporting.
- CSS variable theming (see `app.css` for indigo override of
  `--a2ui-button-primary-bg`).
- The `<A2UIRepresentation>` boundary in `lib/SaveTextField.svelte`.
