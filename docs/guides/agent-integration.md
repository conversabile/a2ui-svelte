# Agent integration

This guide covers wiring an AI agent to A2UI surfaces. It walks through
the `AgentDefinition`, the `AgentModel` interface (and the built-in
models for Gemini, Anthropic, OpenAI, Deepgram and Hume), the
`Agent` orchestrator, the `<AgentShell>` UI, and the tool-result echo
that keeps the model's view of the page current.

The same content in skill form is at
[`integrate-agent`](../../src/lib/skills/integrate-agent.md);
this is the long-form prose version.

## The pieces

```
your app                    a2ui-svelte
─────────                   ────────────
+page.svelte                <StaticSurface> ──► joins mountedSurfaces()
   │                           │                on mount, leaves on unmount
   ├─ session.svelte.ts ◄──────┘  contextInstructions (page prose)
   │
   └─ +layout.svelte
         │
         ├─ AgentDefinition ──► what the agent IS (instructions, surfaces,
         │                      context) — model- and channel-independent
         ├─ a model ───────────► streaming voice (Gemini Live, OpenAI
         │                      Realtime, Deepgram, Hume EVI),
         │                      request/response text (Gemini, Anthropic,
         │                      OpenAI), ScriptedModel (tests), or
         │                      your own
         ├─ Agent(def, model) ► prompt assembly, tool dispatch, surface
         │                      watch, transcript — plus mic/speaker when the
         │                      model's capabilities include audio
         └─ <AgentShell {agent} />
              ▲
              └── the one default UI; grows a mic on audio models;
                  replaceable via snippet slots or headless mode
```

The library does not own:

- Your token endpoint / key proxy (auth is handed to the model).
- Your session store shape (you choose what to push into it).
- Your page layout / styling around the shell.

It owns the audio plumbing, the prompt builder, the surface-watch
heartbeat, the tool-call dispatcher, and the default shell UI.

## The `AgentModel` interface

Provider-specific. The interface is small enough that you can write a
new model in an afternoon:

```ts
import type {
  AgentModel,
  AgentModelEventMap,
  AgentModelCapabilities
} from 'a2ui-svelte/agent';
import type { UserAction } from 'a2ui-svelte/core';

interface AgentModel {
  /** What this model can do — the agent and the shell adapt to THIS,
   *  never to the model's identity. */
  readonly capabilities: AgentModelCapabilities;

  connect(opts: AgentModelConnectOptions): Promise<void>;
  sendText(text: string): void;
  /**
   * Optional. Append text to the model's context WITHOUT triggering a
   * response — the channel the agent uses to *sync* the surface data model
   * into context during idle windows (see "Surface-change delivery" below).
   * Gemini Live implements this via `sendClientContent({ turnComplete: false })`.
   * Models without a silent channel omit it; the agent falls back to
   * `sendText` (which may provoke a turn — acceptable degradation).
   */
  sendContextUpdate?(text: string): void;
  sendToolResult(id: string, name: string, result: unknown): void;
  /**
   * Optional. When implemented, the agent forwards `userAction` events
   * structurally (as a typed event), rather than wrapping them in an
   * XML-tagged text turn. Voice live-APIs without a native event channel
   * — Gemini Live, OpenAI Realtime — should leave this unimplemented and
   * inherit the text-wrapping fallback. Spec-aligned models (A2A
   * `DataPart` with `mimeType: "application/json+a2ui"`) implement it.
   */
  sendUserAction?(action: UserAction): void;
  /**
   * Optional. Stream a mic chunk (16-bit LE PCM @16 kHz, base64). Required
   * exactly when `capabilities.input` includes 'audio' — the agent then runs
   * the mic recorder and calls this for every captured chunk.
   */
  sendAudioChunk?(base64Pcm16k: string): void;
  close(): void;
  on<K extends keyof AgentModelEventMap>(
    event: K,
    cb: (payload: AgentModelEventMap[K]) => void
  ): () => void;
}
```

**Auth belongs to the model, not the agent.** Each implementation
takes its credential in its own constructor and resolves it inside
`connect()` — `GeminiLiveModel({ token })` (a string or a function
minting a fresh ephemeral token per connect), `GeminiTextModel({
apiKey })` or `({ baseUrl })` for a key-hiding proxy. The connect options
the agent assembles carry only `systemInstruction`, `tools`, and
(for client-history models) `history`.

The `UserAction` is always emitted in the spec-canonical shape:

```ts
{
  name:              string,
  surfaceId:         string,
  sourceComponentId: string,
  timestamp:         string,   // ISO-8601, spec-mandated
  context:           Record<string, unknown>  // `{}` if the source component
                                              //  declared no `action.context`
}
```

Events:

| Event             | Payload                                                       |
|-------------------|---------------------------------------------------------------|
| `tool-call`       | `{ calls: Array<{ id, name, args }> }`                        |
| `text-in`         | `{ text: string }`  (user → agent; ASR transcript on voice)  |
| `text-out`        | `{ text: string }`  (agent → user; TTS transcript on voice)  |
| `turn-complete`   | `{}` — only after the tool loop closes, never between `tool-call` and the continuation |
| `audio-out`       | `{ base64Pcm24k: string }` — audio-output models only     |
| `interrupted`     | `{}` — interruptible (barge-in) models only               |
| `usage`           | `AgentUsage` — provider token counts, when reported           |
| `notice`          | `{ message: string }` — non-fatal info (e.g. a 429 retry); folded into the debug feed |
| `error`           | `{ message, cause? }`                                         |
| `close`           | `{ reason: string }`                                          |

### `AgentModelCapabilities`

The descriptor that makes one `Agent` and one `<AgentShell>` serve every
channel:

| Field              | Meaning                                                                  |
|--------------------|--------------------------------------------------------------------------|
| `streaming`        | Persistent bidi session (live socket) vs request/response                 |
| `interruptible`    | Barge-in is real → the agent gates surface-sync off mid-answer            |
| `silentContext`    | Has a real `sendContextUpdate` channel                                    |
| `historyOwnership` | `'server'` (live session holds it; agent embeds prior turns in the prompt) or `'client'` (model owns `messages[]`; agent seeds them via connect `history`) |
| `canInitiateTurn`  | Model can start a model turn on its own (needed by `'proactive'` watch mode) |
| `input` / `output` | Modalities: `['audio', 'text']` lights up the mic/speaker in the agent and the mic cluster in the shell |

A future "voice over a text model" is just a model decorator: wrap a
text model with STT/TTS, advertise `'audio'`, and the same agent and
shell light up the mic — no new classes.

## Built-in models

One per provider/channel, all implementing the same contract — swap the
constructor and nothing else changes. (For provider-level guidance —
free tiers, cost posture, what was evaluated and rejected — see
[model providers](model-providers.md).)

| Model | Import from | Profile | Notes |
|---|---|---|---|
| `GeminiLiveModel` | `a2ui-svelte/agent/gemini` | streaming speech-to-speech | Server tool loop, barge-in, silent context. Auth: ephemeral token (`mintGeminiToken`). |
| `GeminiTextModel` | `a2ui-svelte/agent/gemini` | request/response text | Client tool loop, streamed deltas, 429 retry. Auth: `apiKey` or `baseUrl` proxy. |
| `AnthropicTextModel` | `a2ui-svelte/agent/anthropic` | request/response text | Claude via the official SDK; adaptive thinking on by default (`thinking: false` for pre-4.6 models); default model `claude-opus-4-8`. Auth: `apiKey` or `baseUrl` proxy. |
| `OpenAITextModel` | `a2ui-svelte/agent/openai` | request/response text | Chat Completions via the official SDK; default model `gpt-5.2`. Auth: `apiKey` or `baseUrl` proxy. |
| `OpenAIRealtimeModel` | `a2ui-svelte/agent/openai` | streaming speech-to-speech | GA Realtime WebSocket (`gpt-realtime-2`); barge-in, silent context (item-create without response). Auth: ephemeral client secret (`mintOpenAIRealtimeSecret`). |
| `DeepgramVoiceAgentModel` | `a2ui-svelte/agent/deepgram` | streaming voice (STT→LLM→TTS pipeline) | Whole agent configured over the socket; client-side function calls; native 16 kHz-in/24 kHz-out match. Free signup credits. Auth: grant JWT (`mintDeepgramToken`). |
| `HumeEviModel` | `a2ui-svelte/agent/hume` | streaming speech-to-speech | Empathic Voice Interface; prompt + tools pushed via `session_settings`; free monthly credits. Auth: OAuth token (`fetchHumeAccessToken`). |
| `ScriptedModel` | `a2ui-svelte/agent` | deterministic test double | No LLM, no network. |

The implementations live under `src/lib/agent/{gemini,anthropic,openai,deepgram,hume}/`
— useful references if you're writing a new one. The voice models
adapt their provider's wire formats to the contract's fixed audio shapes
(16 kHz PCM mic in, 24 kHz PCM speaker out) internally — e.g. OpenAI
Realtime upsamples the mic stream, Hume unpacks its WAV output — so the
`Agent`'s recorder/player never special-case a provider.

## Auth: token mints and key proxies

Auth always lives on the model constructor. Two patterns:

**Voice models — short-lived tokens, minted server-side.** Each
voice provider has a mint helper (same shape as the route below): Gemini
Live → `mintGeminiToken` (`a2ui-svelte/agent/gemini`), OpenAI Realtime →
`mintOpenAIRealtimeSecret` (`a2ui-svelte/agent/openai`), Deepgram →
`mintDeepgramToken` (`a2ui-svelte/agent/deepgram`), Hume EVI →
`fetchHumeAccessToken` (`a2ui-svelte/agent/hume`).

```ts
// src/routes/api/voice-token/+server.ts
import { json, error } from '@sveltejs/kit';
import { mintGeminiToken } from 'a2ui-svelte/agent/gemini';
import { GEMINI_API_KEY } from '$env/static/private';

export async function POST() {
  if (!GEMINI_API_KEY) error(503, 'Gemini API key not configured');
  const token = await mintGeminiToken({ apiKey: GEMINI_API_KEY });
  return json({ token });
}
```

Hand the minting function to the model (`token: async () => …`,
Hume: `accessToken`); it is called once per `connect()`, so every
session gets a fresh short-lived credential.

**Text models — same-origin key proxy.** `GeminiTextModel`,
`AnthropicTextModel` and `OpenAITextModel` all accept
`{ baseUrl: '/api/<provider>' }`: the browser sends a placeholder key
and your proxy route injects the real one (`x-goog-api-key`,
`x-api-key`, or `Authorization: Bearer`) before forwarding to the
provider (see
`examples/minimal-app/src/routes/api/gemini/[...path]/+server.ts`).
Passing `apiKey` directly works too, but exposes the key client-side —
development only.

## Finding the surfaces — `mountedSurfaces()`

The library keeps a global index of the surfaces currently on screen:
`<StaticSurface>` and `<DynamicSurface>` add themselves on mount and
remove themselves on destroy, exactly like the tool and action
registries. So an app never has to keep its own list:

```ts
import { mountedSurfaces, surface } from 'a2ui-svelte/core';

mountedSurfaces();          // every mounted surface, in mount order
surface('checkout-form');   // one by id, or undefined
```

`AgentDefinition.surfaces` defaults to `mountedSurfaces` — "whatever is on
screen" needs no wiring at all. Set it to your own callback when the agent
should see less than that (per-route scoping, a surface you deliberately
hide from the model). Surface ids must be unique: two live surfaces with
one id break agent targeting, so the index warns and the newcomer wins.

## `Agent` construction

An agent is a **definition** connected to a **model**:

```ts
import { Agent, type AgentDefinition } from 'a2ui-svelte/agent';
import { GeminiLiveModel, GeminiTextModel } from 'a2ui-svelte/agent/gemini';
import { session } from '$lib/session.svelte';

// What the agent IS — declare once, valid for every model.
const assistant: AgentDefinition = {
  instructions:        'You are a helpful assistant.',
  contextInstructions: () => session.contextInstructions,
  mode:                'static'
  // `surfaces` omitted → every mounted surface
};

// Streaming voice…
const agent = new Agent(
  assistant,
  new GeminiLiveModel({
    token: async () => {
      const r = await fetch('/api/voice-token', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Token mint failed');
      return (await r.json()).token;
    }
  })
);

// …or request/response text. Same definition, same shell, no other change.
const textAgent = new Agent(assistant, new GeminiTextModel({ baseUrl: '/api/gemini' }));

// …or any other provider — still nothing else changes:
//   new AnthropicTextModel({ baseUrl: '/api/claude' })       (a2ui-svelte/agent/anthropic)
//   new OpenAITextModel({ baseUrl: '/api/openai' })          (a2ui-svelte/agent/openai)
//   new OpenAIRealtimeModel({ token: mintFromYourServer })   (a2ui-svelte/agent/openai)
//   new DeepgramVoiceAgentModel({ token: mintFromYourServer }) (a2ui-svelte/agent/deepgram)
//   new HumeEviModel({ accessToken: mintFromYourServer })    (a2ui-svelte/agent/hume)
```

### `mode`

- `'static'` — the agent works with `<StaticSurface>` only. Tools (always):
  `click_button({element_id})`, `update_text_field({element_id, value})`.
  With the `batchTools` extension on (default), the surface also registers
  the batched variants `click_buttons({clicks: […]})` and
  `update_text_fields({updates: […]})`. See *Extension flags* below.
- `'dynamic'` — the agent can render UI on `<DynamicSurface>` via
  `surfaceUpdate`, `dataModelUpdate`, `beginRendering`.
- `'both'` — both sets of tools, both prompt blocks.

Pick the smallest set you need. `'both'` doubles the prompt overhead
and confuses the agent with unused tools.

### `compactSurfaceJson`

```ts
const assistant: AgentDefinition = { …, compactSurfaceJson: true };
```

Serializes the surface JSON on a single line wherever the agent feeds it to
the model — the system prompt's surface blocks and the `SURFACE_UPDATED` sync
payloads — instead of pretty-printing it. Same JSON, same spec compliance;
on the eval fixture it shrinks the prompt by ~30%, and the saving recurs on
**every** turn of the session. Default `false` (pretty) for backwards
compatibility — it is the one token-saving option still off by default;
`toolResultSurfaceEcho: 'delta'` is already on.

### Reactive state

`Agent` exposes Svelte 5 `$state` fields that UIs can read to render the
conversation:

| Field            | Type                                                  |
|------------------|-------------------------------------------------------|
| `connected`      | `boolean`                                             |
| `recording`      | `boolean` — mic capturing (audio models only)     |
| `muted`          | `boolean` — mic muted while the session stays open    |
| `status`         | `'idle' | 'thinking' | 'error'`                       |
| `transcript`     | `Array<{ role: 'user' | 'model', text: string }>`     |
| `hasStarted`     | `boolean`                                             |
| `configIssue`    | `string | null` — surfaces connect/auth failures      |
| `debug`          | `AgentDebugStats` — live token/byte telemetry (below) |
| `trace`          | `AgentTrace` — per-turn debug trace (below)           |

Plus the read-only `capabilities` getter — what the shell uses to decide
whether to render the mic.

### Methods

- `start()` — connect the model; on audio models, also start the mic.
- `stop()` — tear everything down.
- `toggle()` — flip start/stop.
- `toggleMute()` — mute/unmute the mic **without** closing the session. While
  muted, captured audio is dropped instead of sent, so the model hears silence
  while playback and surface-sync keep running — for noisy environments where
  trailing background noise would otherwise barge-in and cut the agent off.
  Inert on models without audio input.
- `send(text, { timeoutMs? })` — send a typed turn and wait for it: resolves at
  the model's `turn-complete` (after the tool round trip, not at the
  intermediate events), rejects if the turn can never complete — not connected,
  model error or close, session stopped, or the deadline elapsed (60 s by
  default). Works on every model; voice live-APIs accept text turns too.
  Use it to disable the composer for exactly as long as the turn lasts.
- `sendTextMessage(text)` — **deprecated**, use `send`. The old fire-and-forget
  form: it can only report a failed turn to the console.
- `on('turn-complete' | 'error', handler)` — subscribe to the agent's own
  events; returns the unsubscribe function. Subscriptions survive
  `stop()`/`start()`. `'error'` fires on a model error and on a close
  nobody asked for.
- `reset()` — clear transcript, stop session, ready for a fresh start.

## Debugging a session

A live session can run up a very large token bill, and the provider answers
with a `RESOURCE_EXHAUSTED` quota error that does not say which part of your
payload was too big. On a **dense static surface** there are two places the
tokens come from:

1. **The whole serialized surface is in the system prompt.** `staticSurfacesBlock`
   embeds `JSON.stringify(surface.getJson(), null, 2)` — *pretty-printed*, which
   inflates the byte size by ~60% over compact. A grid with a few hundred inputs
   (N rows × several editable cells each) can be **100–200 KB ≈ 50k+ tokens**
   on its own, re-counted on every turn of the session.
2. **Every tool result can echo the full surface back.** Under
   `toolResultSurfaceEcho: 'full'`, each `click_button` / `update_text_field`
   result carries `updatedSurface` = the whole surface JSON again (see
   [The tool-result echo](#the-tool-result-echo)). One batched edit adds one
   more copy of the whole surface to the conversation. The default `'delta'`
   sends only the components that actually changed, and only for the surfaces
   that changed; it falls back to the whole tree for one surface only when that
   surface's delta would cost about as much as the tree itself.

So a single 20-field batch update on a large grid can push one turn past a
hundred thousand tokens. `agent.debug` reports the byte size of each thing the
agent sends, so you can see which of the two it was.

### `agent.debug` (`AgentDebugStats`)

Always present, reactive, and cheap. It tracks two things:

- **Exact outbound byte sizes**, per category — measured locally the moment the
  agent sends them, so the bloat shows up *before* the provider responds:
  `system-prompt`, `tools`, `tool-result`, `context-update`, `text`,
  `user-action`, `audio-out`. Each is a `{ count, bytes, lastBytes, estTokens }`.
  (The `audio-*` categories simply stay empty on a text model.)
- **Authoritative provider usage** — Gemini's `usageMetadata`, folded in via
  the model's `'usage'` event: `usage.last`, `usage.peakTotal` (the running
  session total — the figure the quota is measured against), `usage.reports`,
  and `usage.sumPromptTokens` / `usage.sumResponseTokens` (the whole tool
  loop's bill on a request/response model, which no single report shows).

Handy reads:

```ts
agent.debug.outbound['system-prompt'].estTokens   // ~ size of the prompt
agent.debug.outbound['tool-result'].bytes         // the full-surface echo cost
agent.debug.estOutboundTokens                      // est. total context we pushed
agent.debug.usage.last?.totalTokenCount            // real provider count
agent.debug.events                                 // rolling log for a feed
```

> The byte→token figure is a rough estimate (`charsPerToken`, default 4). The
> id-heavy surface JSON tokenizes *above* that, so treat it as a floor; where
> `usage` is present it supersedes the estimate. Construct your own
> `new AgentDebugStats({ charsPerToken })` and pass it as the definition's
> `debug` option to tune it.

### The debug box

Pass `debug` to `<AgentShell>` to wire up the batteries-included panel bound to
`agent.debug`. It adds a chart-icon button to the controls that toggles a stats
box above the bar — collapsed by default so it never blocks the UI, dismissable
from the button or the box's own `×`. "Hot" metrics (a system prompt or
tool-result echo large enough to be the culprit) are highlighted:

```svelte
<AgentShell {agent} debug />
```

That box is the recommended default — most sessions want to watch the same
handful of numbers, so it ships ready to use. If you'd rather render your own
from the same reactive stats, pass a snippet instead (the same toggle button
drives it) with the `formatBytes` / `formatTokens` helpers:

```svelte
<script lang="ts">
  import { formatBytes, formatTokens } from 'a2ui-svelte/agent';
</script>

<AgentShell {agent}>
  {#snippet debug({ debug })}
    System prompt: {formatBytes(debug.outbound['system-prompt'].lastBytes)}
    (~{formatTokens(debug.outbound['system-prompt'].estTokens)} tok) ·
    Tool echoes: {formatBytes(debug.outbound['tool-result'].bytes)}
  {/snippet}
</AgentShell>
```

A custom `controls` snippet receives `toggleDebug` / `isDebugOpen` too, so you
can render the debug toggle wherever your own controls live.

To turn measurement off entirely, pass `debug: false` in the definition (the
`agent.debug` instance still exists, it just stays empty).

### Per-turn detail — `agent.trace` (`AgentTrace`)

The token stats say what a session is costing; the trace says what each turn
did — every tool call it made, with arguments, result and echo, and how the
turn's time split between waiting, generating and those calls. The agent
records one `TraceTurn` per model turn, holding ordered spans:

| Span kind    | Measures                                                     |
|--------------|--------------------------------------------------------------|
| `thinking`   | a response is expected and nothing has come back yet — the wait before the first token, and the wait after each tool result |
| `generating` | text/audio arriving                                          |
| `tool`       | one tool call: `name`, `args`, `output` (the tool's own return value), `status`, `echo` + `echoParts` (the surface echo the agent attached, by key and size), and `sentBytes` (the whole payload the model received) |

Each turn carries the transcript position it belongs at, so the shell charts it
between the user's message and the agent's answer. Reads:

```ts
agent.trace.turns                  // oldest first, capped at 20
agent.trace.turnsAt(2)             // the turns charted at transcript index 2
agent.trace.turns.at(-1)?.spans    // the last turn's waterfall
```

The echo is reported separately from the result because it can be most of the
payload: a 300-byte `{ results: [...] }` goes out as 32 KB once a full
`updatedSurface` is attached. `echoParts` names the cost per key, so the answer
to "why was this call so expensive" is on screen rather than inferred — see
[The tool-result echo](#the-tool-result-echo) for what triggers the full-tree
branch.

Each payload pane has a copy button that yields the exact bytes: arguments,
results and echoes are stored whole, so what you paste into an issue is what
the model received. They are stored as JSON **strings**, never as references,
so the trace can't keep a live surface tree alive; the turn ring (`maxTurns`,
default 20) is what bounds the total, and `maxDetailChars` caps individual
payloads for anyone who would rather not hold a 32 KB echo per call. The same
`debug: false` option turns the whole thing off.

### Turning the debug view on (and off)

The debug view is for development — a chart-icon button in the shell's controls
that reveals the stats box and the per-turn timelines together. `debug="auto"`
enables it in development builds only (`import.meta.env.DEV`), which is what an
app should ship:

```svelte
<AgentShell {agent} debug="auto" />
```

`debug` (or `debug={true}`) forces it on in any build; `debug={false}` (the
default) renders no button at all. Measurement is separate: `debug: false` in
the *definition* stops the agent recording, whatever the shell shows.

### Two settings that cut the token count

One setting addresses each of the two sources above. Both keep the JSON
A2UI-compliant:

1. **`compactSurfaceJson: true`** on the `AgentDefinition` — single-line
   surface JSON in the prompt and sync payloads (~30% smaller prompt on the
   eval fixture; see [`Agent` construction](#compactsurfacejson)). **Off by
   default** — this is the one you still have to set.
2. **`toolResultSurfaceEcho: 'delta'`** — a tool result carries **only what
   changed**: a `surfaceDelta` naming the components that were added, modified
   or removed, plus the changed data-model entries. Surfaces that did not move
   are absent. **On by default**; set it only if you want `'full'` back. See the
   [extensions guide](extensions.md#delta-tool-results-toolresultsurfaceecho-delta).

On the eval suite's 6-row todo list, a 7-call task costs ~169k input tokens
across the request/response loop with the full echo and pretty-printed JSON,
and ~61k with both settings applied. The task result is the same either way.
The `evals/` suite (`pnpm eval`, see [evals/README.md](../../evals/README.md))
measures this without calling a model, and also runs live A/B scenarios against
a real model so you can check that the agent still behaves correctly before you
change the settings in your app.

`toolResultSurfaceEcho: 'none'` (STRICT) removes the echo completely, at a
cost: nothing then tells the model about components that appeared because of
its own action. On models that do not deliver `surfaceWatch` updates
(request/response text), the model will not know the structure changed until
the next user turn. If the surface itself is the problem, the better fix is to
split a large grid into smaller surfaces (one per day, one per department) and
mount only the one currently on screen.

## `<AgentShell>` mounting

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { AgentShell } from 'a2ui-svelte/agent';
  import 'a2ui-svelte/renderer/styles.css';
  // ...definition + model + agent...

  onDestroy(() => agent.stop());
</script>

<slot />
<AgentShell {agent} />
```

One shell for every model: a chat bar (text input + send), a compact
"peek" of the latest exchange, an expandable transcript panel, status
badge, reset and debug controls. When `agent.capabilities.input`
includes `'audio'`, a mic button (session toggle) and a mute button join
the bar — same shell, one extra cluster. Typing lazy-starts the session
on any model; on audio models the mic button is the explicit
session control.

### Snippet slots

`<AgentShell>` accepts replacement snippets for its sub-pieces. You
can opt out of any of them while keeping the rest:

| Snippet      | Receives                                                                |
|--------------|-------------------------------------------------------------------------|
| `messages`   | `{ entries, sendText, trace }` — `trace` is the `AgentTrace` when the debug view is on, else `null` |
| `input`      | `{ sendText, connected, status }`                                       |
| `mic`        | `{ connected, status, toggle, muted, toggleMute }` — only rendered on audio-input models |
| `status`     | `{ status }`                                                            |
| `controls`   | `{ resetConversation, toggleChat, isChatOpen, toggleDebug, isDebugOpen }` |
| `debug`      | `{ debug }` — see [Debugging a session](#debugging-a-session)       |

Or skip the UI entirely with `headless={true}` and render your own
bound to the agent's `$state` fields. `debug` doubles as a prop:
`<AgentShell {agent} debug="auto" />` adds a toggle button — in development
builds only — that reveals the token panel and the per-turn latency timelines.

## The tool-result echo

When the agent calls `click_button` or `update_text_field`, the tool runs the
action and returns a bare `{ results }`. But the agent usually also
wants to *see* the page afterwards — to confirm a navigation happened, or to
learn about a field the click reset.

The **`Agent` adds that echo**, under `extensions['a2ui-svelte']`, from the
surfaces your own `AgentDefinition` declares:

```ts
export const assistant: AgentDefinition = {
  instructions: '…',
  contextInstructions: () => session.contextInstructions
  // `surfaces` — the default (every mounted surface) is what the echo reports
};
```

So there is nothing extra to wire: the same `surfaces()` and
`contextInstructions()` the system prompt is built from are what the echo
reports. How much it reports is the `toolResultSurfaceEcho` extension —
`'full'`, `'delta'` (the default: a per-component diff) or `'none'` — see
[extensions.md](extensions.md#delta-tool-results-toolresultsurfaceecho-delta).

Under `'delta'` the echo diffs the flat `components` list against what this
model was last told, so the cost tracks the change, not the page. A recomputed
total on a 300-component grid is one component entry; a surface that did not
move is not mentioned at all.

**Calling a tool directly.** `toolRegistry.execute('click_button', { element_id })`
from `a2ui-svelte/core` is the entry point for an external agent (and for
tests). It drives the surface and returns exactly `{ results: [...] }` — no
echo, because the echo is an agent-level concern. The names are ours, not
A2UI's, so a spec-only agent won't call them unprompted.

## Extensions (`Extensions`)

The library is 100% A2UI v0.8 compliant on its **default** surface
wire, plus a handful of non-spec behaviours that are useful in
practice (surface-change watching, batched click/update tools, a
richer tool-result envelope, a pointer tool). Every non-spec behaviour
ships behind one field of the app-wide `Extensions` record and emits
its data under the `extensions: { 'a2ui-svelte': ... }` envelope, so a
spec-compliant 3P consumer just drops what it doesn't recognise.

**Extensions describe the app, not a surface and not the `Agent`.**
There is one record for the whole app, set once at startup with
`configureExtensions` — half the extensions name a *global* tool, so two
surfaces cannot disagree about whether a tool name exists. (Cadence knobs
like polling interval are exposed separately in the agent definition;
they're not extensions.)

### The four extensions

| Extension               | Default  | What it does                                                                                                                                                                                                                            |
|-------------------------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `surfaceWatch`          | `true`   | The `Agent` keeps the model aware of user-driven changes to the mounted surfaces. *How* the change is delivered is governed by `surfaceWatchTuning.mode` — a silent, idle-timed data-model sync (`'sync'`, default) or a proactive `<event>SURFACE_UPDATED</event>` text turn (`'proactive'`). See "Surface-change delivery" below. The payload is wrapped under `extensions['a2ui-svelte']`. |
| `batchTools`            | `true`   | Registers batched variants `click_buttons({clicks: […]})` and `update_text_fields({updates: […]})` alongside the single-element `click_button` / `update_text_field`. The agent prompt is taught to prefer batching when many ops fall together. |
| `toolResultSurfaceEcho` | `'delta'` | How much of the post-action surface a click / update result echoes back under `extensions['a2ui-svelte']`. `'delta'` (default) — a `surfaceDelta`: only the components that changed, in only the surfaces that changed. (`'changed'` is a deprecated alias.) `'full'` — the whole snapshot (`updatedSurface`, `updatedContext`, `availableElementIds`), every call. `'none'` — results are just `{ results: [...] }`, exactly what the spec promises. |
| `pointerTool`           | `true`   | Registers `point_to_elements({element_ids})`, a non-spec gesture that scrolls components into view and glows them so the agent can point at on-screen data without changing it. |

`STRICT` is the all-off preset; `ALL_EXTRAS` is the all-on default (where "on"
for `toolResultSurfaceEcho` means `'delta'`, not `'full'`).
Both are exported from `a2ui-svelte/core`.

### Setting them

```svelte
<!-- src/routes/+layout.svelte — once, at startup -->
<script lang="ts">
  import { configureExtensions } from 'a2ui-svelte/core';
  configureExtensions({ pointerTool: false });
</script>
```

The partial is merged over `ALL_EXTRAS`, not over the current record — the
call is an absolute set, so `configureExtensions({})` restores the defaults.
Surfaces read the record when they register their tools, so call it before
any surface mounts. `getExtensions()` reads it back anywhere.

On the server the record is module-level and shared by every request. That
is correct — it describes the app, not the user — but it is one more reason
to set it at startup rather than per request.

**Spec-strict:**

```ts
import { configureExtensions, STRICT } from 'a2ui-svelte/core';
configureExtensions(STRICT);
```

### Surface-change delivery (`surfaceWatchTuning`)

When the user changes a watched surface (types into a field, navigates,
edits through the HTML UI), the agent needs to learn about it. *Whether*
surfaces are watched is the app-wide `surfaceWatch` extension; *how* the
change reaches the agent is a behaviour/cadence knob, so it lives in the
agent definition, not in `Extensions`:

```ts
const assistant: AgentDefinition = {
  // ...,
  surfaceWatchTuning: {
    mode: 'sync',        // 'sync' (default) | 'proactive'
    intervalMs: 500,     // poll cadence — checks for an undelivered change
    settleMs: 400,       // debounce window — coalesce mid-typing values
    cooldownMs: 5000     // proactive only — suppress echo of agent's own writes
  }
};
```

**`mode: 'sync'` (default) — A2UI v0.9 data-model synchronization.**
The agent stays *silently aware* of what the user has typed, without ever
interrupting its own answer. The unit of state is the surface's **data
model** — a `{ fieldId → value }` map — not the component tree. The static
structure is already in the system prompt and doesn't change when the user
types, so only the **changed values** are pushed (a tiny delta, tens of
bytes, not the whole tree). Delivery happens **only in idle windows** — a
debounced settle tick, `turn-complete`, or right before a typed
message / button action — through the model's `sendContextUpdate`
channel (`turnComplete: false`, so it adds to context without provoking a
response). On an interruptible (live) model it is **never** sent while
the model is generating, so it can't barge-in-interrupt the answer. Edits
made while the agent is speaking are buffered and coalesced (latest value
per field wins), then flushed the instant the model goes idle. The effect:
if the user types "John" into a field and then asks "what's in the box?",
the model already sees "John" when it answers — but it never comments on
the typing on its own.

On a non-streaming (request/response) model there is no live session to
push into between turns, so no poll timer runs at all — the same data-model
state is flushed right before each typed message / button action instead,
which gives the model the current UI before it answers.

Each delivery is a diff against what the model was last told, and the payload
takes whichever of three shapes describes it most cheaply:

- `kind: 'clientDataModel'` — only data-model values moved (the user typed).
  The A2UI v0.9 shape, carrying the changed entries.
- `kind: 'surfaceDelta'` — component definitions moved. Per surface: the
  components to upsert by id (`changed`), the ids that went away (`removed`),
  and the changed data-model entries. Surfaces that did not move are absent;
  `removedSurfaces` names surfaces that unmounted.
- `kind: 'surfaceUpdated'` — every mounted surface has to be replaced at once
  (navigation to a different page). The whole trees.

A single surface that needs replacing wholesale travels inside `surfaceDelta`
as an entry with `full: true`.

`intervalMs` is the poll cadence (polling only *detects* a change; it doesn't
deliver on its own). `settleMs` is how long a value must hold steady before
it's delivered, so mid-typing values ("Joh" → "John") coalesce into one
delivery. Keep `intervalMs` below `settleMs` for fine settle resolution.

> **Cheap deltas are automatic, for every kind of change.** Value-bearing
> inputs path-bind their value into the data model, so a keystroke moves only
> the data model. Anything that is *not* a bound value — a `Text` showing a
> recomputed total, a `Button` becoming disabled — is held as a literal inside
> its component definition, and the diff reports just that component. Neither
> costs a full re-sync.
> `<StaticSurface>` / `<DynamicSurface>` expose the data model to the agent via
> `getDataModel()`; hand-rolled surface handles can implement it too, or let
> the agent derive it from `getJson()`.

**`mode: 'proactive'` — the agent reacts to changes unprompted.**
A timer (`intervalMs`) diffs the surface and pushes a turn-triggering
`<event>SURFACE_UPDATED</event>` text turn (the full tree) as soon as a
change *settles*. `settleMs` debounces in-flight edits. `cooldownMs`
suppresses re-reporting the agent's own tool-call writes. Surface-id changes
(navigation) bypass both windows. Useful for a chattier assistant that
narrates UI activity — but note it *can* interrupt, since it triggers a
turn. Requires `capabilities.canInitiateTurn`; on models that can't
start their own turn it falls back to `'sync'` with a console warning.

**`mode: 'piggyback'`** is a deprecated alias for `'sync'` (the old
implementation flushed the full tree on the user's first transcript chunk,
which on Gemini Live arrives at turn-close and interrupted the answer). The
name still works; it resolves to `'sync'`.

Whether any mode does anything is still decided per-surface: a surface with
`surfaceWatch: false` is never watched.

## Testing

The full picture — component tests, end-to-end, what is not worth
asserting — is in [testing.md](testing.md); running the agent against a
real model is in [evals.md](evals.md). What follows is the agent half.

For deterministic, network-free tests, use the built-in
`ScriptedModel` — a queue of programmed model reactions:

```ts
import { Agent, ScriptedModel } from 'a2ui-svelte/agent';

render(MyPage);   // the page's surfaces join the index as they mount

const model = new ScriptedModel([
  { on: 'save it', calls: [{ name: 'click_button', args: { element_id: 'save-btn' } }], text: 'Saved.' }
]);
const agent = new Agent({ instructions: 'persona' }, model);
await agent.start();
await agent.send('please save it');   // resolves at the model's turn-complete
// assert the action ran, the tool result echoed, the transcript updated…
```

`await agent.send(…)` is the turn boundary — no sleep, no polling. If a test
hangs on it, the scripted turn never completed; pass `{ timeoutMs }` below the
runner's own timeout to get a message that says so.

For finer control, write a stub model that emits synthetic events —
implement `AgentModel`, return a `capabilities` object matching the
profile you want to exercise (the agent's gates key off it), and re-emit
events from your test. The library's own `agent.test.ts` defines
`MockAgentModel` this way; note that if your mock advertises
`'audio'` modalities, the agent will try to construct the mic recorder /
speaker player, so tests in jsdom should either stub
`./audio-recorder`/`./audio-player` or advertise text-only modalities.

### `withoutAudio(model)` — a real voice model, headless

To drive a **real** voice model where there is no mic or speaker
(node/jsdom evals, a headless deployment), wrap it:

```ts
import { Agent, withoutAudio } from 'a2ui-svelte/agent';
import { GeminiLiveModel } from 'a2ui-svelte/agent/gemini';

const agent = new Agent(definition, withoutAudio(new GeminiLiveModel({ token })));
```

It strips `'audio'` from `capabilities.input`/`output` and hides
`sendAudioChunk`, so the `Agent` runs the session text-in/text-out and
starts no recorder or player. Everything else forwards untouched. **The
model still generates audio, so the token bill is unchanged — exactly the
production load**; the frames are dropped and the output transcription
carries the text.

## Extending the agent

The extension axis is the **model** (new providers, wrappers like
STT/TTS-around-text) and the **definition** (instructions, prompt
override via `buildPrompt`, watch tuning; guardrails and subagents are
planned to land here as uniform mechanics). The shell extends through
its snippet slots or `headless` mode. Subclassing `Agent` is **not**
supported — wrap, don't subclass.

## Pitfalls

- **Duplicate surface ids.** The agent names components by id; two
  surfaces sharing one id is ambiguous for it and for `surface(id)`.
  The index warns in the console — give each surface its own id.
- **Stale surfaces in `surfaces()` callback.** The callback is invoked
  whenever the agent needs the live surface state — on every poll tick and at
  each idle flush in `'sync'` mode, and on every timer tick in `'proactive'`
  mode (see `surfaceWatchTuning`). If your store is paused or memoised
  incorrectly, the agent acts on stale JSON. Always read live state.
- **Forgetting `agent.stop()` on `onDestroy`.** Hot reload leaks
  recorder instances. Always tear down.
- **Sending text before connecting.** `agent.send` while
  `agent.connected === false` rejects without sending. The
  default `<AgentShell>` lazy-starts the session on the first send; if you
  build your own UI, do the same or check `agent.connected` first.
- **Pico-less projects forgetting `renderer/styles.css`.** The shell
  CSS lives there; without it, the bottom bar will look unstyled.

## A2A (network) integration mode

`AgentModel` covers model APIs where this library owns the agent and
drives UI via LLM function tools. A2UI v0.8 also defines a spec-aligned,
network-shaped integration: a unidirectional server-to-client stream of
A2A `DataPart`s (typically over SSE) carrying surface mutations, paired
with a client-to-server channel for `userAction` / `error` events. The
library ships this as a sibling family rooted at `a2ui-svelte/transport`:

```ts
import type {
  A2ATransport, A2UIServerMessage, A2UIClientEvent
} from 'a2ui-svelte/transport';
import { A2ASurface } from 'a2ui-svelte/renderer';
import { getClientCapabilities, STANDARD_CATALOG_ID } from 'a2ui-svelte/core';

const transport: A2ATransport = createMyA2ATransport({
  getClientCapabilities: () => getClientCapabilities({
    [STANDARD_CATALOG_ID]: DEFAULT_CATALOG
  })
});
```

```svelte
<A2ASurface surfaceId="main" {transport}
  catalogs={{ [STANDARD_CATALOG_ID]: DEFAULT_CATALOG }} />
```

The adapter routes all **four** server→client messages
(`surfaceUpdate`, `beginRendering`, `dataModelUpdate`, `deleteSurface`)
through `processMessage()` and forwards `userAction` events raised on
its own `surfaceId` through `transport.sendEvent()`.

### Envelope contract

Every implementation must honour the A2A envelope on the wire:

- Each A2UI message rides inside an A2A `Message` whose `DataPart` has
  `mimeType: "application/json+a2ui"` and `data: <A2UI JSON>`.
  Use `wrapA2A` / `unwrapA2A` from `a2ui-svelte/transport`.
- The HTTP request carries `X-A2A-Extensions:
  https://a2ui.org/a2a-extension/a2ui/v0.8` (or the equivalent gRPC
  metadata). The constants `A2A_EXTENSIONS_HEADER` and
  `A2UI_V0_8_EXTENSION_URI` are exported from `a2ui-svelte/transport`.
- **Every** outbound client→server `Message` carries
  `a2uiClientCapabilities` in `metadata` — not just the first.
  `getClientCapabilities()` is injected via `A2ATransportOptions` so
  the transport calls it on every send (capabilities can evolve as
  dynamically-loaded catalogs come online).
- For surfaces that enabled v0.9 **`sendDataModel`**, that same `metadata`
  also carries `a2uiClientDataModel` — the surface's **full current data
  model** (no deltas; the metadata channel replaces the prior copy each
  send). Inject the optional `getClientDataModel()` accessor via
  `A2ATransportOptions`; build the payload with
  `getClientDataModel(surfaceIds)` from `a2ui-svelte/core` and attach it via
  `wrapA2A(event, { clientCapabilities, clientDataModel })`:

  ```ts
  import { getClientCapabilities, getClientDataModel, STANDARD_CATALOG_ID } from 'a2ui-svelte/core';
  import { wrapA2A } from 'a2ui-svelte/transport';

  const transport = createMyA2ATransport({
    getClientCapabilities: () => getClientCapabilities({ [STANDARD_CATALOG_ID]: DEFAULT_CATALOG }),
    // the surface ids you opted into sendDataModel for:
    getClientDataModel: () => getClientDataModel(['main'])
  });

  // inside the transport's sendEvent(event):
  const message = wrapA2A(event, {
    clientCapabilities: opts.getClientCapabilities(),
    clientDataModel: opts.getClientDataModel?.()
  });
  ```

  This is the spec-faithful, byte-for-byte v0.9 path. A live audio API
  can't use it (it has no metadata side-channel, and attaching state at
  speech time interrupts the answer), so the agent synchronises the same
  `{ fieldId → value }` unit via in-band **deltas** instead — see
  "Surface-change delivery" above and the surface-data-model-sync plan.

Reference SSE / WebSocket implementations are deferred to a follow-up;
the interface and envelope contract are defined now so adapters and
downstream consumers can be built and tested independently.

### Catalog selection (handshake)

Catalog selection is a one-shot handshake, not a negotiation:

1. The **server** advertises supported catalogs in its AgentCard
   (`AgentCapabilities.extensions[].params`) — use
   `getAgentCardExtensionParams({ catalogs, acceptsInlineCatalogs })`
   from `a2ui-svelte/core` to serialise this when exposing an
   A2UI-driving agent.
2. The **client** declares its supported catalogs in every outbound A2A
   message's metadata — use `getClientCapabilities(catalogs)`.
3. The server picks a `catalogId` per surface via `beginRendering`. If
   omitted, the client MUST default to the v0.8 standard catalog
   (`STANDARD_CATALOG_ID = "https://a2ui.org/specification/v0_8/standard_catalog_definition.json"`).

`<DynamicSurface>` and `<A2ASurface>` both honour this — register your
catalog under the URI and the resolver picks it automatically:

```ts
<DynamicSurface
  surfaceId="m1"
  catalogs={{
    [STANDARD_CATALOG_ID]: DEFAULT_CATALOG,
    'https://myapp.example/a2ui/v0_8/catalog': MY_CUSTOM_CATALOG
  }}
/>
```
