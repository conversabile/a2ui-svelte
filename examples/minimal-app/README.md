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

## Switch the agent model

The **Agent model** picker in the header swaps the *transport* — and
nothing else. One `AgentDefinition` (persona + surfaces + context), one
`Agent`, one `<AgentShell>` serve both choices:

- **Streaming — Gemini Live (voice).** `GeminiLiveTransport` over the bidi
  Live socket. The shell sees audio in `agent.capabilities` and grows the
  mic + mute cluster. Talk to it (or type — the chat bar is always there).
- **Text — Gemini 3.5 Flash (chat).** `GeminiTextTransport` over the
  request/response API. Same shell, no mic. Type to it.

Auth belongs to each transport: the Live transport mints an ephemeral
token per connect (`src/routes/api/voice-token/+server.ts`); the text
transport routes through a same-origin proxy
(`src/routes/api/gemini/[...path]/+server.ts`) via its `baseUrl` option,
so `GEMINI_API_KEY` never reaches the browser.

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
  `a2ui-svelte/authoring`, `a2ui-svelte/agent`, `a2ui-svelte/agent/gemini`.
- One agent, two channels: the same `AgentDefinition` connected to either
  `GeminiLiveTransport` (streaming voice) or `GeminiTextTransport`
  (request/response text), rendered by the single `<AgentShell>` that
  adapts itself to `agent.capabilities`.
- Keeping the text model's key server-side via a `baseUrl` proxy route.
- The `session.svelte.ts` pattern for publishing surfaces to the
  layout-level shell.
- The `SurfaceFeedback` context for tool-result reporting.
- The on-demand `point_to_elements` highlight extension (default-on) —
  ask the agent to point something out and it glows + scrolls into view.
- CSS variable theming (see `app.css` for indigo override of
  `--a2ui-button-primary-bg`).
- The `<A2UIRepresentation>` boundary in `lib/StarRating.svelte`.
