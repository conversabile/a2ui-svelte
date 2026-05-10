# Voice integration

This guide covers wiring a voice agent to A2UI surfaces. It walks
through the `VoiceTransport` interface, the `VoiceAgent` orchestrator,
the `<VoiceShell>` UI, and the `SurfaceFeedback` context that bridges
your app's session store to the library's tool result reporting.

The same content in skill form is at
[`integrate-voice-agent`](../../src/lib/skills/integrate-voice-agent.md);
this is the long-form prose version.

## The pieces

```
your app                    a2ui-svelte
─────────                   ────────────
+page.svelte                <StaticSurface>
   │                           │
   ├─ session.svelte.ts ◄──────┘  surfaces, contextInstructions
   │
   └─ +layout.svelte
         │
         ├─ GeminiTransport (or your VoiceTransport impl)
         ├─ VoiceAgent ──────► owns the audio loop, prompt assembly,
         │                     tool dispatch, surface watch
         └─ <VoiceShell {agent} />
              ▲
              └── default UI; replaceable via snippet slots or headless mode
```

The library does not own:

- Your token endpoint (`/api/voice-token`).
- Your session store shape (you choose what to push into it).
- Your page layout / styling around the shell.

It owns the audio plumbing, the prompt builder, the surface-watch
heartbeat, the tool-call dispatcher, and the default mic/transcript UI.

## The `VoiceTransport` interface

Provider-specific. The interface is small enough that you can write a
new transport in an afternoon:

```ts
import type { VoiceTransport, VoiceTransportEventMap } from 'a2ui-svelte/voice';

interface VoiceTransport {
  connect(opts: VoiceTransportConnectOptions): Promise<void>;
  sendAudioChunk(base64Pcm16k: string): void;
  sendText(text: string): void;
  sendToolResult(id: string, name: string, result: unknown): void;
  close(): void;
  on<K extends keyof VoiceTransportEventMap>(
    event: K,
    cb: (payload: VoiceTransportEventMap[K]) => void
  ): () => void;
}
```

Events:

| Event             | Payload                                                       |
|-------------------|---------------------------------------------------------------|
| `tool-call`       | `{ calls: Array<{ id, name, args }> }`                        |
| `audio-out`       | `{ base64Pcm24k: string }`                                    |
| `transcript-in`   | `{ text: string }`  (user → agent)                            |
| `transcript-out`  | `{ text: string }`  (agent → user)                            |
| `interrupted`     | `{}`                                                          |
| `turn-complete`   | `{}`                                                          |
| `error`           | `{ message, cause? }`                                         |
| `close`           | `{ reason: string }`                                          |

The Gemini implementation lives at `voice/gemini/transport.ts` — a
useful reference if you're writing a new one.

## Token mint

Voice transports authenticate with short-lived ephemeral tokens, not
your raw API key. Mint them server-side:

```ts
// src/routes/api/voice-token/+server.ts
import { json, error } from '@sveltejs/kit';
import { mintGeminiToken } from 'a2ui-svelte/voice/gemini';
import { GEMINI_API_KEY } from '$env/static/private';

export async function POST() {
  if (!GEMINI_API_KEY) error(503, 'Gemini API key not configured');
  const token = await mintGeminiToken({ apiKey: GEMINI_API_KEY });
  return json({ token });
}
```

The token is consumed once per `agent.start()`. If your provider
rotates keys, mint fresh on every connect.

## `VoiceAgent` construction

```ts
import { VoiceAgent } from 'a2ui-svelte/voice';
import { GeminiTransport } from 'a2ui-svelte/voice/gemini';
import { session } from '$lib/session.svelte';

const transport = new GeminiTransport({ model: 'gemini-3.1-flash-live-preview' });

const agent = new VoiceAgent({
  transport,
  surfaces:            () => session.surfaces,
  contextInstructions: () => session.contextInstructions,
  systemInstruction:   'You are a helpful assistant.',
  mode:                'static',
  mintToken: async () => {
    const r = await fetch('/api/voice-token', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Token mint failed');
    return (await r.json()).token;
  }
});
```

### `mode`

- `'static'` — the agent works with `<StaticSurface>` only. Tools:
  `click_button`, `update_text_field`, `set_checkbox`, etc.
- `'dynamic'` — the agent can render UI on `<DynamicSurface>` via
  `surfaceUpdate`, `dataModelUpdate`, `beginRendering`.
- `'both'` — both sets of tools, both prompt blocks.

Pick the smallest set you need. `'both'` doubles the prompt overhead
and confuses the agent with unused tools.

### Reactive state

`VoiceAgent` exposes Svelte 5 `$state` fields you can bind anywhere:

| Field            | Type                                                  |
|------------------|-------------------------------------------------------|
| `connected`      | `boolean`                                             |
| `recording`      | `boolean`                                             |
| `status`         | `'idle' | 'thinking' | 'error'`                       |
| `transcript`     | `Array<{ role: 'user' | 'model', text: string }>`     |
| `hasStarted`     | `boolean`                                             |
| `configIssue`    | `string | null` — surfaces token-mint failures        |

### Methods

- `start()` — connect transport, start mic.
- `stop()` — tear everything down.
- `toggle()` — flip start/stop.
- `sendTextMessage(text)` — type into the transcript without speaking.
- `reset()` — clear transcript, stop session, ready for a fresh start.

## `<VoiceShell>` mounting

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy, setContext } from 'svelte';
  import { VoiceShell } from 'a2ui-svelte/voice';
  import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
  import 'a2ui-svelte/renderer/styles.css';
  // ...transport + agent...

  onDestroy(() => agent.stop());
</script>

<slot />
<VoiceShell {agent} />
```

### Snippet slots

`<VoiceShell>` accepts replacement snippets for its sub-pieces. You
can opt out of any of them while keeping the rest:

| Snippet      | Receives                                                                |
|--------------|-------------------------------------------------------------------------|
| `mic`        | `{ connected, status, toggle }`                                         |
| `transcript` | `{ entries, sendText }`                                                 |
| `status`     | `{ status }`                                                            |
| `controls`   | `{ resetConversation, toggleChat, isChatOpen }`                         |

Or skip the UI entirely with `headless={true}` and render your own
bound to the agent's `$state` fields.

## `SurfaceFeedback` context

When the agent calls a tool, `VoiceAgent` runs the action handler and
sends `{ status: 'success' }` back as the result. But often the agent
wants to *see* the surface after the action ran — for instance, to
confirm a navigation actually happened.

The library exposes a `SurfaceFeedback` Svelte context the consumer
fills in. The library reads it at tool-result time and substitutes the
fresh surface JSON into the result.

```ts
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

The `JSON.parse(JSON.stringify(...))` clone is required: Svelte 5
reactive proxies don't survive the live API serialiser.

## Testing with `MockTransport`

For unit tests, write a stub transport that emits synthetic events.
The shape:

```ts
class MockTransport implements VoiceTransport {
  #listeners: Partial<{ [K in keyof VoiceTransportEventMap]: Array<(p: VoiceTransportEventMap[K]) => void> }> = {};

  async connect() {}
  sendAudioChunk(_b64: string) {}
  sendText(_t: string) {}
  sendToolResult(_id: string, _name: string, _r: unknown) {}
  close() {}

  on<K extends keyof VoiceTransportEventMap>(
    event: K, cb: (p: VoiceTransportEventMap[K]) => void
  ): () => void {
    (this.#listeners[event] ??= []).push(cb as never);
    return () => {
      this.#listeners[event] = this.#listeners[event]?.filter((c) => c !== cb) as never;
    };
  }

  emit<K extends keyof VoiceTransportEventMap>(event: K, p: VoiceTransportEventMap[K]) {
    this.#listeners[event]?.forEach((cb) => (cb as (x: typeof p) => void)(p));
  }
}
```

Then in a test:

```ts
const transport = new MockTransport();
const agent = new VoiceAgent({ transport, /* ... */ });
await agent.start();
transport.emit('tool-call', { calls: [{ id: '1', name: 'click_button', args: { id: 'save' } }] });
// assert handler ran, transcript updated, etc.
```

The library's own tests use this pattern — see `agent.test.ts` for a
full example.

## Extending `VoiceAgent`

The current `VoiceAgent` is intentionally a single class. Future
versions may grow into a micro-agentic framework with sub-agents and
guardrails — that's why the file is named `agent.svelte.ts` rather
than `gemini-live.svelte.ts`. Treat extension points (`buildPrompt`
override, `mode` flag, snippet slots) as the public API for now;
inheritance is **not** supported yet — wrap, don't subclass.

## Pitfalls

- **Stale surfaces in `surfaces()` callback.** The callback is invoked
  on every 3-second tick. If your store is paused or memoised
  incorrectly, the agent acts on stale JSON. Always read live state.
- **Forgetting `agent.stop()` on `onDestroy`.** Hot reload leaks
  recorder instances. Always tear down.
- **Sending text before connecting.** `agent.sendTextMessage` while
  `agent.connected === false` is a no-op with a console warning. Check
  `agent.connected` first.
- **Pico-less projects forgetting `renderer/styles.css`.** The shell
  CSS lives there; without it, the bottom bar will look unstyled.
