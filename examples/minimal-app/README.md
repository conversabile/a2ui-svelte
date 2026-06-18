# a2ui-svelte minimal example

Smoke-test consumer for the `a2ui-svelte` library. Demonstrates every
public API in three pages.

## Run

```bash
# from the repo root
pnpm install
cp examples/minimal-app/.env.template examples/minimal-app/.env
# edit .env — add at least one real provider key (placeholders stay disabled)
pnpm --filter minimal-app dev
```

Open http://localhost:5173.

`.env.template` lists every provider key the app understands. You only
need one — the **Agent model** picker enables a model exactly when its
provider's key is set (a `fake-…` placeholder counts as unset). The
cheapest voice option to try is **Deepgram** ($200 free signup credits,
no card); **Hume** has a free monthly tier; the **Gemini** free-tier key
lights up both Gemini models at once.

## Switch the agent model

The **Agent model** picker in the header swaps the *transport* — and
nothing else. One `AgentDefinition` (persona + surfaces + context), one
`Agent`, one `<AgentShell>` serve every choice, grouped into:

- **Voice (streaming).** `GeminiLiveTransport`, `OpenAIRealtimeTransport`,
  `DeepgramVoiceAgentTransport`, `HumeEviTransport`. The shell sees audio
  in `agent.capabilities` and grows the mic + mute cluster. Talk to it
  (or type — the chat bar is always there).
- **Text (chat).** `GeminiTextTransport`, `AnthropicTextTransport`,
  `OpenAITextTransport` over each provider's request/response API. Same
  shell, no mic. Type to it.

Auth belongs to each transport. Voice transports mint a short-lived
credential per connect via `src/routes/api/voice-token/[provider]/`
(Gemini ephemeral token, OpenAI client secret, Deepgram grant JWT, Hume
OAuth token). Text transports route through a same-origin key proxy
(`src/routes/api/{gemini,claude,openai}/[...path]/`) via their `baseUrl`
option, so the real API key never reaches the browser. Which providers
are enabled is reported (booleans only) by `src/routes/api/providers/`.
For the trade-offs between providers — free tiers, native
speech-to-speech vs. STT→LLM→TTS pipelines, what was evaluated and
rejected — see the
[transport providers guide](../../docs/guides/transport-providers.md).

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
  `a2ui-svelte/authoring`, `a2ui-svelte/agent`, and the per-provider
  transport entries `a2ui-svelte/agent/{gemini,anthropic,openai,deepgram,hume}`.
- One agent, seven transports: the same `AgentDefinition` connected to any
  of four streaming-voice transports or three request/response text
  transports, rendered by the single `<AgentShell>` that adapts itself to
  `agent.capabilities`.
- Gating the model picker on which provider keys are configured
  (`/api/providers` returns booleans only).
- Keeping each text model's key server-side via a `baseUrl` proxy route,
  and minting short-lived voice credentials per connect.
- The `session.svelte.ts` pattern for publishing surfaces to the
  layout-level shell.
- The `SurfaceFeedback` context for tool-result reporting.
- The on-demand `point_to_elements` highlight extension (default-on) —
  ask the agent to point something out and it glows + scrolls into view.
- CSS variable theming (see `app.css` for indigo override of
  `--a2ui-button-primary-bg`).
- The `<A2UIRepresentation>` boundary in `lib/StarRating.svelte`.
