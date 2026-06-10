---
name: integrate-agent
description: Use when wiring an AI agent (voice via Gemini Live, text via Gemini request/response, or a custom AgentTransport) to the A2UI surfaces in a SvelteKit app. Covers the AgentDefinition, transport auth, AgentShell mounting, and the SurfaceFeedback context.
type: skill
---

# Integrate an agent

## When to use this skill

Use this skill when you need to **connect a live AI agent** to the
A2UI surfaces declared on your pages. The agent reads your surfaces,
dispatches tool calls back to your action handlers, and gives the user
a chat bar — with a microphone when the transport supports audio.

Trigger phrases: "wire up the agent", "set up Gemini Live", "add the
mic", "add a chat agent", "connect a custom transport", "integrate
voice", "integrate the assistant".

## How to apply

### 1. Declare the agent definition

The definition is what the agent *is* — persona, surfaces, page
context. It is a plain object, independent of any model or channel;
the same definition runs over every transport.

```ts
import type { AgentDefinition } from 'a2ui-svelte/agent';
import { session } from '$lib/session.svelte';

const assistant: AgentDefinition = {
  instructions: 'You are a helpful assistant. Always be concise.',
  surfaces: () => session.surfaces,
  contextInstructions: () => session.contextInstructions,
  mode: 'static' // 'static' | 'dynamic' | 'both'
};
```

The `surfaces` and `contextInstructions` callbacks are invoked on every
surface-watch tick *and* on every tool call. Keep them fast — they
should just read reactive state, not do work.

### 2. Construct a transport (auth lives here)

**Streaming voice (Gemini Live).** Authenticates with a short-lived
ephemeral token, not your raw API key. Mint server-side:

```ts
// src/routes/api/voice-token/+server.ts
import { json, error } from '@sveltejs/kit';
import { mintGeminiToken } from 'a2ui-svelte/agent/gemini';
import { GEMINI_API_KEY } from '$env/static/private';

export async function POST() {
  if (!GEMINI_API_KEY) error(503, 'AI assistant is not configured');
  const token = await mintGeminiToken({ apiKey: GEMINI_API_KEY });
  return json({ token });
}
```

```ts
import { GeminiLiveTransport } from 'a2ui-svelte/agent/gemini';

const transport = new GeminiLiveTransport({
  // called once per connect — every session gets a fresh single-use token
  token: async () => {
    const r = await fetch('/api/voice-token', { method: 'POST' });
    if (!r.ok) throw new Error('Token mint failed');
    return (await r.json()).token;
  }
});
```

**Request/response text (Gemini).** Keep the key server-side with a
same-origin proxy route that injects `x-goog-api-key`:

```ts
import { GeminiTextTransport } from 'a2ui-svelte/agent/gemini';

const transport = new GeminiTextTransport({ baseUrl: '/api/gemini' });
// or, key in the browser (dev only): new GeminiTextTransport({ apiKey })
```

**Custom provider.** Implement the `AgentTransport` interface
(`a2ui-svelte/agent`): a `capabilities` getter (this is what the agent
and shell adapt to — modalities, barge-in, silent context, history
ownership), `connect`, `sendText`, `sendToolResult`, `close`, plus an
`on(event, cb)` emitter for `tool-call`, `text-in`, `text-out`,
`turn-complete`, `error`, `close` (and `audio-out` / `interrupted` /
`usage` where applicable). Audio transports also implement
`sendAudioChunk`. Optionally implement `sendContextUpdate(text)` — a
channel that appends to the model's context *without* triggering a
response (Gemini Live: `sendClientContent({ turnComplete: false })`);
the agent uses it to sync the surface data model into context during
idle windows; transports that omit it fall back to `sendText`.

### 3. Connect the definition to the transport

```ts
import { Agent } from 'a2ui-svelte/agent';

const agent = new Agent(assistant, transport);
```

That's the whole orchestrator. Swapping the second argument switches
voice ↔ text ↔ scripted-test without touching anything else.

### 4. Mount `<AgentShell>` (or render headless UI)

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy, setContext } from 'svelte';
  import { AgentShell } from 'a2ui-svelte/agent';
  import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
  import 'a2ui-svelte/renderer/styles.css';
  import { session } from '$lib/session.svelte';
  // ...definition + transport + agent construction from steps 1–3...

  // See step 5 for SurfaceFeedback wiring.
  onDestroy(() => agent.stop());
</script>

<slot />
<AgentShell {agent} />
```

One shell for every transport: chat bar, transcript peek/panel, status,
reset and debug controls. When `agent.capabilities.input` includes
`'audio'`, a mic button (session toggle) and a mute button join the bar
automatically. Typing lazy-starts the session on any transport.

For a headless setup (custom UI):

```svelte
<AgentShell {agent} headless={true} />

<button onclick={() => agent.toggle()}>
  {agent.connected ? 'Stop' : 'Start'}
</button>
{#each agent.transcript as msg}
  <p><strong>{msg.role}:</strong> {msg.text}</p>
{/each}
```

`agent.connected`, `agent.recording`, `agent.muted`, `agent.status`,
`agent.transcript`, `agent.hasStarted`, `agent.configIssue` are all
`$state` — bind freely. `agent.capabilities` tells you what the
transport can do.

### 5. Wire `SurfaceFeedback` context for tool result reporting

When the agent calls a tool, the action handler runs synchronously and
returns. But the agent often wants to know *what the surface looks like
after the action* — and your surface state may have changed (a route
navigation, a list re-fetch). The `SurfaceFeedback` Svelte context lets
the library snapshot the latest surface JSON and feed it back as the
tool's result, instead of just `{ status: 'success' }`.

```ts
import { setContext } from 'svelte';
import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';

const surfaceFeedback: SurfaceFeedback = {
  globalSurfaces: () =>
    JSON.parse(JSON.stringify(
      session.surfaces.filter((s) => s && s.type === 'static').map((s) => s.getJson())
    )),
  contextInstructions: () => session.contextInstructions
};
setContext<SurfaceFeedback>(SURFACE_FEEDBACK_KEY, surfaceFeedback);
```

The `JSON.parse(JSON.stringify(...))` step is required: Svelte 5 proxies
must be detached before they go through the live API serialiser.

### 6. Test with `ScriptedTransport` (no model, no network)

```ts
import { Agent, ScriptedTransport } from 'a2ui-svelte/agent';

const transport = new ScriptedTransport([
  {
    on: 'save it',
    calls: [{ name: 'click_button', args: { element_id: 'save-btn' } }],
    text: 'Saved.'
  }
]);
const agent = new Agent(assistant, transport);
await agent.start();
agent.sendTextMessage('please save it');
// assert the action ran, transport.toolResults echoed, transcript updated…
```

For finer control, stub `AgentTransport` yourself and emit synthetic
events; advertise text-only modalities in `capabilities` unless your
test environment can construct Web Audio objects.

## Common variations

- **Multiple modes.** Set `mode: 'both'` if your app uses both static
  and dynamic surfaces. The prompt builder will include guidance for
  both. `'dynamic'` only registers the `surfaceUpdate` /
  `dataModelUpdate` / `beginRendering` tools.
- **Custom prompt.** Pass `buildPrompt: (inputs) => string` in the
  definition to override the assembled system prompt entirely. Use
  `staticSurfacesBlock`, `toolsBlock`, etc. from `a2ui-svelte/agent` to
  compose your own.
- **Custom TTS voice.** `new GeminiLiveTransport({ token, voice: 'Charon' })`.
- **Bring-your-own UI.** `headless={true}` plus snippet slots
  (`messages`, `input`, `mic`, `status`, `controls`, `debug`) let you
  mix-and-match — replace one piece, keep the rest.

## Related skills

- `build-a2ui-page` — making a page the agent can read.
- `style-and-theme` — restyling the default `<AgentShell>`.
