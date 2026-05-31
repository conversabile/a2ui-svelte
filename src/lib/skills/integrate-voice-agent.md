---
name: integrate-voice-agent
description: Use when wiring a voice agent (Gemini Live or other VoiceTransport) to the A2UI surfaces in a SvelteKit app. Covers token mint, agent construction, VoiceShell mounting, and the SurfaceFeedback context.
type: skill
---

# Integrate a voice agent

## When to use this skill

Use this skill when you need to **connect a live voice agent** to the
A2UI surfaces declared on your pages. The agent reads a snapshot of
your surfaces every few seconds, dispatches tool calls back to your
action handlers, and gives the user a microphone UI.

Trigger phrases: "wire up the voice agent", "set up Gemini Live", "add
the mic", "connect a custom voice transport", "integrate voice".

## How to apply

### 1. Mint a token server-side

Voice transports authenticate with a short-lived ephemeral token, not
your raw API key. The library ships `mintGeminiToken` for the Gemini
provider — call it from a SvelteKit `+server.ts` endpoint:

```ts
// src/routes/api/voice-token/+server.ts
import { json, error } from '@sveltejs/kit';
import { mintGeminiToken } from 'a2ui-svelte/voice/gemini';
import { GEMINI_API_KEY } from '$env/static/private';

export async function POST() {
  if (!GEMINI_API_KEY) error(503, 'AI assistant is not configured');
  const token = await mintGeminiToken({ apiKey: GEMINI_API_KEY });
  return json({ token });
}
```

For other providers, write your own helper that returns a string token
the transport can pass to the live API.

### 2. Construct a transport

```ts
import { GeminiTransport } from 'a2ui-svelte/voice/gemini';
const transport = new GeminiTransport({ model: 'gemini-3.1-flash-live-preview' });
```

For a custom provider, implement the `VoiceTransport` interface
(`a2ui-svelte/voice`). The interface is small: `connect`,
`sendAudioChunk`, `sendText`, `sendToolResult`, `close`, plus an `on(event, cb)`
event emitter for `tool-call`, `audio-out`, `transcript-in`,
`transcript-out`, `interrupted`, `turn-complete`, `error`, `close`.
Optionally implement `sendContextUpdate(text)` — a channel that appends to
the model's context *without* triggering a response (Gemini Live:
`sendClientContent({ turnComplete: false })`). The agent uses it to sync the
surface data model into context during idle windows in the default
`surfaceWatchTuning.mode: 'sync'` (A2UI v0.9 data-model sync); transports that
omit it fall back to `sendText`.

### 3. Construct a `VoiceAgent`

```ts
import { VoiceAgent } from 'a2ui-svelte/voice';
import { session } from '$lib/session.svelte';

const agent = new VoiceAgent({
  transport,
  surfaces: () => session.surfaces,
  contextInstructions: () => session.contextInstructions,
  systemInstruction: 'You are a helpful assistant. Always be concise.',
  mode: 'static',  // 'static' | 'dynamic' | 'both'
  mintToken: async () => {
    const r = await fetch('/api/voice-token', { method: 'POST' });
    if (!r.ok) throw new Error('Token mint failed');
    const { token } = await r.json();
    return token;
  }
});
```

The `surfaces` and `contextInstructions` callbacks are invoked on every
3-second surface-watch tick *and* on every tool call. Keep them fast —
they should just read reactive state, not do work.

### 4. Mount `<VoiceShell>` (or render headless UI)

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy, setContext } from 'svelte';
  import { VoiceShell } from 'a2ui-svelte/voice';
  import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
  import 'a2ui-svelte/renderer/styles.css';
  import { session } from '$lib/session.svelte';
  // ...transport + agent construction from steps 2–3...

  // See step 5 for SurfaceFeedback wiring.
  onDestroy(() => agent.stop());
</script>

<slot />
<VoiceShell {agent} />
```

For a headless setup (custom mic, custom transcript UI):

```svelte
<VoiceShell {agent} headless={true} />

<button onclick={() => agent.toggle()}>
  {agent.connected ? 'Stop' : 'Start'}
</button>
{#each agent.transcript as msg}
  <p><strong>{msg.role}:</strong> {msg.text}</p>
{/each}
```

`agent.connected`, `agent.recording`, `agent.status`, `agent.transcript`,
`agent.hasStarted`, `agent.configIssue` are all `$state` — bind freely.

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

### 6. Stub a custom `VoiceTransport`

```ts
import type {
  VoiceTransport,
  VoiceTransportConnectOptions,
  VoiceTransportEventMap
} from 'a2ui-svelte/voice';

class MockTransport implements VoiceTransport {
  #listeners: { [K in keyof VoiceTransportEventMap]?: Array<(p: VoiceTransportEventMap[K]) => void> } = {};

  async connect(_o: VoiceTransportConnectOptions) { /* open WS, etc. */ }
  sendAudioChunk(_b64: string) { /* forward */ }
  sendText(_t: string) { /* forward */ }
  sendToolResult(_id: string, _name: string, _result: unknown) { /* forward */ }
  close() { /* tear down */ }

  on<K extends keyof VoiceTransportEventMap>(
    event: K, cb: (p: VoiceTransportEventMap[K]) => void
  ): () => void {
    (this.#listeners[event] ??= []).push(cb as never);
    return () => {
      this.#listeners[event] = this.#listeners[event]?.filter((c) => c !== cb) as never;
    };
  }

  // Test helpers — emit synthetic events from your tests.
  emit<K extends keyof VoiceTransportEventMap>(event: K, payload: VoiceTransportEventMap[K]) {
    this.#listeners[event]?.forEach((cb) => (cb as (p: typeof payload) => void)(payload));
  }
}
```

Use it in tests by passing it in place of `GeminiTransport`.

## Common variations

- **Multiple modes.** Set `mode: 'both'` if your app uses both static
  and dynamic surfaces. The prompt builder will include guidance for
  both. `'dynamic'` only registers the `surfaceUpdate` /
  `dataModelUpdate` / `beginRendering` tools.
- **Custom prompt.** Pass `buildPrompt: (inputs) => string` to override
  the assembled system prompt entirely. Use `staticSurfacesBlock`,
  `toolsBlock`, etc. from `a2ui-svelte/voice` to compose your own.
- **Bring-your-own UI.** `headless={true}` plus snippet slots (`mic`,
  `transcript`, `status`, `controls`) let you mix-and-match — replace
  one piece, keep the rest.

## Related skills

- `build-a2ui-page` — making a page the agent can read.
- `style-and-theme` — restyling the default `<VoiceShell>`.
