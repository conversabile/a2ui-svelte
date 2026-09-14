---
name: integrate-agent
description: Use when wiring an AI agent (voice via Gemini Live / OpenAI Realtime / Deepgram / Hume EVI, text via Gemini / Anthropic Claude / OpenAI, or a custom AgentModel) to the A2UI surfaces in a SvelteKit app. Covers the AgentDefinition, model auth, AgentShell mounting, and the tool-result echo.
type: skill
---

# Integrate an agent

## When to use this skill

Use this skill when you need to **connect a live AI agent** to the
A2UI surfaces declared on your pages. The agent reads your surfaces,
dispatches tool calls back to your action handlers, and gives the user
a chat bar — with a microphone when the model supports audio.

Trigger phrases: "wire up the agent", "set up Gemini Live", "use
Claude/GPT for the agent", "set up OpenAI Realtime", "add the
mic", "add a chat agent", "connect a custom model", "integrate
voice", "integrate the assistant".

## How to apply

### 1. Declare the agent definition

The definition is what the agent *is* — persona, surfaces, page
context. It is a plain object, independent of any model or channel;
the same definition runs over every model.

```ts
// src/lib/agent-definition.ts
import type { AgentDefinition } from 'a2ui-svelte/agent';
import { mountedSurfaces } from 'a2ui-svelte/core';
import { session } from '$lib/session.svelte';

const assistant: AgentDefinition = {
  instructions: 'You are a helpful assistant. Always be concise.',
  surfaces: mountedSurfaces,
  contextInstructions: () => session.contextInstructions,
  mode: 'static' // 'static' | 'dynamic' | 'both'
};
```

`mountedSurfaces()` is the library's own index: every `<StaticSurface>` /
`<DynamicSurface>` joins it on mount and leaves on destroy, so pages
publish nothing. Write your own callback only when the agent should see
less than what is on screen (per-route scoping, a surface you hide from
the model); `surface(id)` from the same module gets one by id.

Keep the definition in its own module (the layout then holds only the
model). Both callbacks are invoked on every surface-watch tick *and*
on every tool call, so keep them fast — read reactive state, don't do work.

### 2. Construct a model (auth lives here)

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
import { GeminiLiveModel } from 'a2ui-svelte/agent/gemini';

const model = new GeminiLiveModel({
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
import { GeminiTextModel } from 'a2ui-svelte/agent/gemini';

const model = new GeminiTextModel({ baseUrl: '/api/gemini' });
// or, key in the browser (dev only): new GeminiTextModel({ apiKey })
```

**Other built-in providers.** Same contract, same agent, same shell —
only the constructor changes. Text (request/response, `apiKey` or a
`baseUrl` key proxy exactly like Gemini's):

```ts
import { AnthropicTextModel } from 'a2ui-svelte/agent/anthropic';
import { OpenAITextModel } from 'a2ui-svelte/agent/openai';

new AnthropicTextModel({ baseUrl: '/api/claude' });  // Claude (default claude-opus-4-8)
new OpenAITextModel({ baseUrl: '/api/openai' });     // GPT (default gpt-5.2)
```

Streaming voice (each authenticates with a short-lived credential minted
server-side by the matching helper, exactly like the Gemini route above):

```ts
import { OpenAIRealtimeModel } from 'a2ui-svelte/agent/openai';   // mintOpenAIRealtimeSecret
import { DeepgramVoiceAgentModel } from 'a2ui-svelte/agent/deepgram'; // mintDeepgramToken
import { HumeEviModel } from 'a2ui-svelte/agent/hume';            // fetchHumeAccessToken

new OpenAIRealtimeModel({ token: fetchTokenFromYourServer });
new DeepgramVoiceAgentModel({ token: fetchTokenFromYourServer });
new HumeEviModel({ accessToken: fetchTokenFromYourServer });
```

**Custom provider.** Implement the `AgentModel` interface
(`a2ui-svelte/agent`): a `capabilities` getter (this is what the agent
and shell adapt to — modalities, barge-in, silent context, history
ownership), `connect`, `sendText`, `sendToolResult`, `close`, plus an
`on(event, cb)` emitter for `tool-call`, `text-in`, `text-out`,
`turn-complete`, `error`, `close` (and `audio-out` / `interrupted` /
`usage` / `notice` where applicable — `notice` is a non-fatal info
signal, e.g. a rate-limit retry, that the agent logs to its debug box).
Audio models also implement `sendAudioChunk`. Optionally implement
`sendContextUpdate(text)` — a channel that appends to the model's context
*without* triggering a response (Gemini Live: `sendClientContent({ turnComplete: false })`);
the agent uses it to sync the surface data model into context during
idle windows; models that omit it fall back to `sendText`.

### 3. Connect the definition to the model

```ts
import { Agent } from 'a2ui-svelte/agent';

const agent = new Agent(assistant, model);
```

That's the whole orchestrator. Swapping the second argument switches
voice ↔ text ↔ scripted-test without touching anything else.

### 4. Mount `<AgentShell>` (or render headless UI)

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { AgentShell } from 'a2ui-svelte/agent';
  import 'a2ui-svelte/renderer/styles.css';
  // ...definition + model + agent construction from steps 1–3...

  onDestroy(() => agent.stop());
</script>

<slot />
<AgentShell {agent} />
```

One shell for every model: chat bar, transcript peek/panel, status,
reset and debug controls. When `agent.capabilities.input` includes
`'audio'`, a mic button (session toggle) and a mute button join the bar
automatically. Typing lazy-starts the session on any model.

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
model can do.

### 5. The tool-result echo — nothing to wire

When the agent calls `click_button` / `update_text_field`, the tool runs the
action and returns a bare `{ results }`. The **`Agent`** then
attaches what the page looks like afterwards, under
`extensions['a2ui-svelte']`, reading the same `surfaces()` and
`contextInstructions()` your `AgentDefinition` already declares (step 1). So
`surfaces: mountedSurfaces` is the whole wiring.

Size it with the app-wide `toolResultSurfaceEcho` extension:

```ts
import { configureExtensions } from 'a2ui-svelte/core';

// once, at startup, before any surface mounts
configureExtensions({ toolResultSurfaceEcho: 'full' }); // 'full' | 'changed' | 'none'
```

`'changed'` (default): the result contains only the values the action changed.
`'full'`: every result contains the whole surface JSON again — on a big
surface that is what makes the token count explode. `'none'`: the result is
exactly `{ results }` and nothing else, which is what the spec defines.

Driving a surface without an `Agent` (tests, or an external agent) goes
through the registry and gets no echo. The tool names are ours, not A2UI's:

```ts
import { toolRegistry } from 'a2ui-svelte/core';
await toolRegistry.execute('click_button', { element_id: 'save-btn' });
```

Every tool reports each element as `{ element_id, status: 'success' | 'error' }`
— those two values only, with a message in `error` when it failed. Nothing
throws: a bad element id comes back as an `error` item so the model can
recover. In a test use `agentClick` / `agentFill` / `agentCall` from
`a2ui-svelte/testing`, which throw on exactly that.

### 6. Test with `ScriptedModel` (no LLM, no network)

```ts
import { Agent, ScriptedModel } from 'a2ui-svelte/agent';

const model = new ScriptedModel([
  {
    on: 'save it',
    calls: [{ name: 'click_button', args: { element_id: 'save-btn' } }],
    text: 'Saved.'
  }
]);
const agent = new Agent(assistant, model);
await agent.start();
await agent.send('please save it');   // resolves at the model's turn-complete
// assert the action ran, model.toolResults echoed, transcript updated…
```

`agent.send()` resolves at the turn boundary (after any tool round trip) and
rejects if the turn can't finish — so a test never sleeps. (`sendTextMessage`
is the deprecated fire-and-forget form; don't write new code against it.)

For finer control, stub `AgentModel` yourself and emit synthetic
events; advertise text-only modalities in `capabilities` unless your
test environment can construct Web Audio objects. To drive a **real**
voice model where there is no mic or speaker (node/jsdom evals, a
headless deployment), wrap it in `withoutAudio` from `a2ui-svelte/agent`:
it strips the `'audio'` modality and hides `sendAudioChunk`, so the agent
runs the session text-in/text-out. The model still generates audio — the
token bill is the production one; only the frames are dropped.

## Common variations

- **Multiple modes.** Set `mode: 'both'` if your app uses both static
  and dynamic surfaces. The prompt builder will include guidance for
  both. `'dynamic'` only registers the `surfaceUpdate` /
  `dataModelUpdate` / `beginRendering` tools.
- **Dense surfaces / quota pressure.** Tool results already report only
  what changed (`toolResultSurfaceEcho: 'changed'` is the default), but
  the prompt still embeds the surface pretty-printed. Set
  `compactSurfaceJson: true` on the definition (single-line surface JSON,
  ~30% smaller prompt) — it is the one token-saving option still off by
  default. On a 6-row todo-list fixture a 7-call task drops from ~169k
  (full echo + pretty JSON) to ~61k billed input tokens with both on,
  with identical outcomes.
- **Custom prompt.** Pass `buildPrompt: (inputs) => string` in the
  definition to override the assembled system prompt entirely. Use
  `staticSurfacesBlock`, `toolsBlock`, etc. from `a2ui-svelte/agent` to
  compose your own.
- **Custom TTS voice.** `new GeminiLiveModel({ token, voice: 'Charon' })`.
- **Bring-your-own UI.** `headless={true}` plus snippet slots
  (`messages`, `input`, `mic`, `status`, `controls`, `debug`) let you
  mix-and-match — replace one piece, keep the rest.

## Related skills

- `build-a2ui-page` — making a page the agent can read.
- `style-and-theme` — restyling the default `<AgentShell>`.
- `test-a2ui-app` — testing the wiring: agent actions, `ScriptedModel`,
  evals.
