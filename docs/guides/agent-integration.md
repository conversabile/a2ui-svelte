# Agent integration

This guide covers wiring an AI agent to A2UI surfaces. It walks through
the `AgentDefinition`, the `AgentTransport` interface (and the two
built-in Gemini transports), the `Agent` orchestrator, the
`<AgentShell>` UI, and the `SurfaceFeedback` context that bridges your
app's session store to the library's tool result reporting.

The same content in skill form is at
[`integrate-agent`](../../src/lib/skills/integrate-agent.md);
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
         ├─ AgentDefinition ──► what the agent IS (instructions, surfaces,
         │                      context) — model- and channel-independent
         ├─ a transport ──────► GeminiLiveTransport (streaming voice),
         │                      GeminiTextTransport (request/response),
         │                      ScriptedTransport (tests), or your own
         ├─ Agent(def, transport) ► prompt assembly, tool dispatch, surface
         │                      watch, transcript — plus mic/speaker when the
         │                      transport's capabilities include audio
         └─ <AgentShell {agent} />
              ▲
              └── the one default UI; grows a mic on audio transports;
                  replaceable via snippet slots or headless mode
```

The library does not own:

- Your token endpoint / key proxy (auth is handed to the transport).
- Your session store shape (you choose what to push into it).
- Your page layout / styling around the shell.

It owns the audio plumbing, the prompt builder, the surface-watch
heartbeat, the tool-call dispatcher, and the default shell UI.

## The `AgentTransport` interface

Provider-specific. The interface is small enough that you can write a
new transport in an afternoon:

```ts
import type {
  AgentTransport,
  AgentTransportEventMap,
  TransportCapabilities
} from 'a2ui-svelte/agent';
import type { UserAction } from 'a2ui-svelte/core';

interface AgentTransport {
  /** What this transport can do — the agent and the shell adapt to THIS,
   *  never to the transport's identity. */
  readonly capabilities: TransportCapabilities;

  connect(opts: AgentTransportConnectOptions): Promise<void>;
  sendText(text: string): void;
  /**
   * Optional. Append text to the model's context WITHOUT triggering a
   * response — the channel the agent uses to *sync* the surface data model
   * into context during idle windows (see "Surface-change delivery" below).
   * Gemini Live implements this via `sendClientContent({ turnComplete: false })`.
   * Transports without a silent channel omit it; the agent falls back to
   * `sendText` (which may provoke a turn — acceptable degradation).
   */
  sendContextUpdate?(text: string): void;
  sendToolResult(id: string, name: string, result: unknown): void;
  /**
   * Optional. When implemented, the agent forwards `userAction` events
   * structurally (as a typed event), rather than wrapping them in an
   * XML-tagged text turn. Voice live-APIs without a native event channel
   * — Gemini Live, OpenAI Realtime — should leave this unimplemented and
   * inherit the text-wrapping fallback. Spec-aligned transports (A2A
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
  on<K extends keyof AgentTransportEventMap>(
    event: K,
    cb: (payload: AgentTransportEventMap[K]) => void
  ): () => void;
}
```

**Auth belongs to the transport, not the agent.** Each implementation
takes its credential in its own constructor and resolves it inside
`connect()` — `GeminiLiveTransport({ token })` (a string or a function
minting a fresh ephemeral token per connect), `GeminiTextTransport({
apiKey })` or `({ baseUrl })` for a key-hiding proxy. The connect options
the agent assembles carry only `systemInstruction`, `tools`, and
(for client-history transports) `history`.

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
| `turn-complete`   | `{}`                                                          |
| `audio-out`       | `{ base64Pcm24k: string }` — audio-output transports only     |
| `interrupted`     | `{}` — interruptible (barge-in) transports only               |
| `usage`           | `AgentUsage` — provider token counts, when reported           |
| `error`           | `{ message, cause? }`                                         |
| `close`           | `{ reason: string }`                                          |

### `TransportCapabilities`

The descriptor that makes one `Agent` and one `<AgentShell>` serve every
channel:

| Field              | Meaning                                                                  |
|--------------------|--------------------------------------------------------------------------|
| `streaming`        | Persistent bidi session (live socket) vs request/response                 |
| `interruptible`    | Barge-in is real → the agent gates surface-sync off mid-answer            |
| `silentContext`    | Has a real `sendContextUpdate` channel                                    |
| `historyOwnership` | `'server'` (live session holds it; agent embeds prior turns in the prompt) or `'client'` (transport owns `messages[]`; agent seeds them via connect `history`) |
| `canInitiateTurn`  | Transport can start a model turn on its own (needed by `'proactive'` watch mode) |
| `input` / `output` | Modalities: `['audio', 'text']` lights up the mic/speaker in the agent and the mic cluster in the shell |

A future "voice over a text model" is just a transport decorator: wrap a
text transport with STT/TTS, advertise `'audio'`, and the same agent and
shell light up the mic — no new classes.

The built-in implementations live at
`src/lib/agent/gemini/live-transport.ts` (streaming audio, server-side
tool loop) and `src/lib/agent/gemini/text-transport.ts` (request/response,
client-side tool loop) — useful references if you're writing a new one.

## Token mint (Gemini Live)

The Live transport authenticates with short-lived ephemeral tokens, not
your raw API key. Mint them server-side:

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

Hand the minting function to the transport; it is called once per
`connect()`, so every session gets a fresh single-use token.

For `GeminiTextTransport`, keep the key server-side with a same-origin
proxy instead: construct it with `{ baseUrl: '/api/gemini' }` and have
that route inject the real `x-goog-api-key` (see
`examples/minimal-app/src/routes/api/gemini/[...path]/+server.ts`).

## `Agent` construction

An agent is a **definition** connected to a **transport**:

```ts
import { Agent, type AgentDefinition } from 'a2ui-svelte/agent';
import { GeminiLiveTransport, GeminiTextTransport } from 'a2ui-svelte/agent/gemini';
import { session } from '$lib/session.svelte';

// What the agent IS — declare once, valid for every transport.
const assistant: AgentDefinition = {
  instructions:        'You are a helpful assistant.',
  surfaces:            () => session.surfaces,
  contextInstructions: () => session.contextInstructions,
  mode:                'static'
};

// Streaming voice…
const agent = new Agent(
  assistant,
  new GeminiLiveTransport({
    token: async () => {
      const r = await fetch('/api/voice-token', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Token mint failed');
      return (await r.json()).token;
    }
  })
);

// …or request/response text. Same definition, same shell, no other change.
const textAgent = new Agent(assistant, new GeminiTextTransport({ baseUrl: '/api/gemini' }));
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

### Reactive state

`Agent` exposes Svelte 5 `$state` fields you can bind anywhere:

| Field            | Type                                                  |
|------------------|-------------------------------------------------------|
| `connected`      | `boolean`                                             |
| `recording`      | `boolean` — mic capturing (audio transports only)     |
| `muted`          | `boolean` — mic muted while the session stays open    |
| `status`         | `'idle' | 'thinking' | 'error'`                       |
| `transcript`     | `Array<{ role: 'user' | 'model', text: string }>`     |
| `hasStarted`     | `boolean`                                             |
| `configIssue`    | `string | null` — surfaces connect/auth failures      |
| `debug`          | `AgentDebugStats` — live token/byte telemetry (below) |

Plus the read-only `capabilities` getter — what the shell uses to decide
whether to render the mic.

### Methods

- `start()` — connect the transport; on audio transports, also start the mic.
- `stop()` — tear everything down.
- `toggle()` — flip start/stop.
- `toggleMute()` — mute/unmute the mic **without** closing the session. While
  muted, captured audio is dropped instead of sent, so the model hears silence
  while playback and surface-sync keep running — for noisy environments where
  trailing background noise would otherwise barge-in and cut the agent off.
  Inert on transports without audio input.
- `sendTextMessage(text)` — send a typed turn (works on every transport;
  voice live-APIs accept text turns too).
- `reset()` — clear transcript, stop session, ready for a fresh start.

## Debugging token usage

A live session can quietly run up an enormous token bill, and providers
answer with an opaque `RESOURCE_EXHAUSTED` quota error that gives no hint
as to *why*. On a **dense static surface** the cause is usually structural,
and it has two amplifiers:

1. **The whole serialized surface is in the system prompt.** `staticSurfacesBlock`
   embeds `JSON.stringify(surface.getJson(), null, 2)` — *pretty-printed*, which
   inflates the byte size by ~60% over compact. A grid with a few hundred inputs
   (a week × N staff × shift slots × start/end) can be **100–200 KB ≈ 50k+
   tokens** on its own, re-counted on every turn of the session.
2. **Every tool result echoes the full surface back.** With the
   `toolResultExtras` extension on (the default), each `click_button` /
   `update_text_field` result carries `updatedSurface` = the whole surface JSON
   again (see [`SurfaceFeedback`](#surfacefeedback-context)). One batched edit
   ⇒ one more full-surface copy injected into context.

So even a *single* 20-field batch update on a large grid can push one turn well
past a hundred thousand tokens. `agent.debug` makes that visible.

### `agent.debug` (`AgentDebugStats`)

Always present, reactive, and cheap. It tracks two things:

- **Exact outbound byte sizes**, per category — measured locally the moment the
  agent sends them, so the bloat shows up *before* the provider responds:
  `system-prompt`, `tools`, `tool-result`, `context-update`, `text`,
  `user-action`, `audio-out`. Each is a `{ count, bytes, lastBytes, estTokens }`.
  (The `audio-*` categories simply stay empty on a text transport.)
- **Authoritative provider usage** — Gemini's `usageMetadata`, folded in via
  the transport's `'usage'` event: `usage.last`, `usage.peakTotal` (the running
  session total — the figure the quota is measured against), `usage.reports`.

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

> **Mitigations** the numbers point to: serialize the surface compactly for the
> prompt; split a huge grid into smaller per-day/department surfaces and only
> publish the visible one; or set `toolResultExtras: false` (STRICT) so tool
> results stop echoing the whole surface and rely on `surfaceWatch` deltas
> instead.

## `<AgentShell>` mounting

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy, setContext } from 'svelte';
  import { AgentShell } from 'a2ui-svelte/agent';
  import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
  import 'a2ui-svelte/renderer/styles.css';
  // ...definition + transport + agent...

  onDestroy(() => agent.stop());
</script>

<slot />
<AgentShell {agent} />
```

One shell for every transport: a chat bar (text input + send), a compact
"peek" of the latest exchange, an expandable transcript panel, status
badge, reset and debug controls. When `agent.capabilities.input`
includes `'audio'`, a mic button (session toggle) and a mute button join
the bar — same shell, one extra cluster. Typing lazy-starts the session
on any transport; on audio transports the mic button is the explicit
session control.

### Snippet slots

`<AgentShell>` accepts replacement snippets for its sub-pieces. You
can opt out of any of them while keeping the rest:

| Snippet      | Receives                                                                |
|--------------|-------------------------------------------------------------------------|
| `messages`   | `{ entries, sendText }`                                                 |
| `input`      | `{ sendText, connected, status }`                                       |
| `mic`        | `{ connected, status, toggle, muted, toggleMute }` — only rendered on audio-input transports |
| `status`     | `{ status }`                                                            |
| `controls`   | `{ resetConversation, toggleChat, isChatOpen, toggleDebug, isDebugOpen }` |
| `debug`      | `{ debug }` — see [Debugging token usage](#debugging-token-usage)       |

Or skip the UI entirely with `headless={true}` and render your own
bound to the agent's `$state` fields. `debug` doubles as a boolean prop:
`<AgentShell {agent} debug />` adds a toggle button that reveals the built-in
token panel.

## `SurfaceFeedback` context

When the agent calls a tool, the `Agent` runs the action handler and
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

## Extension flags (`ExtensionOptions`)

The library is 100% A2UI v0.8 compliant on its **default** surface
wire, plus a handful of non-spec behaviours that are useful in
practice (surface-change polling, batched click/update tools, a
richer tool-result envelope). Every non-spec behaviour ships behind a
single per-surface flag in `ExtensionOptions` and emits its data
under the `extensions: { 'a2ui-svelte': ... }` envelope, so a
spec-compliant 3P consumer just drops what it doesn't recognise.

**Extensions are properties of surfaces, not of the `Agent`.** Each
`<StaticSurface>` resolves its own flag record. The `Agent` reads
`surface.extensions` from each handle it sees and decides what to do
on a per-surface basis — it never carries a top-level extension
toggle of its own. (Cadence knobs like polling interval are exposed
separately in the agent definition; they're not feature flags.)

### The three flags

| Flag                | Default | What it does                                                                                                                                                                                                                            |
|---------------------|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `surfaceWatch`      | `true`  | The `Agent` keeps the model aware of user-driven changes to this surface. *How* the change is delivered is governed by `surfaceWatchTuning.mode` — a silent, idle-timed data-model sync (`'sync'`, default) or a proactive `<event>SURFACE_UPDATED</event>` text turn (`'proactive'`). See "Surface-change delivery" below. The payload is wrapped under `extensions['a2ui-svelte']`. |
| `batchTools`        | `true`  | The surface registers batched variants `click_buttons({clicks: […]})` and `update_text_fields({updates: […]})` alongside the spec-canonical single-element `click_button` / `update_text_field`. The agent prompt is taught to prefer batching when many ops fall together. |
| `toolResultExtras`  | `true`  | The result of every click / update call carries a post-action snapshot (`updatedSurface`, `updatedContext`, `availableElementIds`) under `extensions['a2ui-svelte']`. With this off, results are just `{ results: [...] }` and a spec-strict client gets exactly what the spec promises. |

Each flag is independent — toggle any subset. `STRICT` is the
all-off preset; `ALL_EXTRAS` is the all-on default. Both presets are
exported from `a2ui-svelte/core`.

### Resolution order

A `<StaticSurface>` resolves its flags from, in order:

1. its `options={...}` prop;
2. the Svelte context set under `A2UI_EXTENSIONS_CONTEXT_KEY` at the
   integration root (host-wide default);
3. the `ALL_EXTRAS` preset (every flag `true`).

### Presets

```ts
import { ALL_EXTRAS, STRICT, A2UI_EXTENSIONS_CONTEXT_KEY } from 'a2ui-svelte/core';
```

- `ALL_EXTRAS` — every extension on. The library's default.
- `STRICT` — every extension off. The wire is pure v0.8.

### Common setups

**Default.** Do nothing — `ALL_EXTRAS` is the default; the layout-level
agent definition carries no extension flags.

**Spec-strict host-wide:**

```svelte
<script lang="ts">
  import { setContext } from 'svelte';
  import { STRICT, A2UI_EXTENSIONS_CONTEXT_KEY } from 'a2ui-svelte/core';
  setContext(A2UI_EXTENSIONS_CONTEXT_KEY, STRICT);
</script>
```

Every `<StaticSurface>` mounted in this subtree behaves spec-strictly
unless it overrides via its own `options` prop.

**Per-surface override:**

```svelte
<StaticSurface surfaceId="readonly-view" options={STRICT}>...</StaticSurface>
<StaticSurface surfaceId="rich-editor"   options={{ batchTools: false }}>...</StaticSurface>
```

### Surface-change delivery (`surfaceWatchTuning`)

When the user changes a watched surface (types into a field, navigates,
edits through the HTML UI), the agent needs to learn about it. *Whether* a
surface is watched is the per-surface `surfaceWatch` flag; *how* the change
reaches the agent is a behaviour/cadence knob, so it lives in the agent
definition, not in `ExtensionOptions`:

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
message / button action — through the transport's `sendContextUpdate`
channel (`turnComplete: false`, so it adds to context without provoking a
response). On an interruptible (live) transport it is **never** sent while
the model is generating, so it can't barge-in-interrupt the answer. Edits
made while the agent is speaking are buffered and coalesced (latest value
per field wins), then flushed the instant the model goes idle. The effect:
if the user types "John" into a field and then asks "what's in the box?",
the model already sees "John" when it answers — but it never comments on
the typing on its own.

On a non-streaming (request/response) transport there is no live session to
push into between turns, so no poll timer runs at all — the same data-model
state is flushed right before each typed message / button action instead,
which gives the model the current UI before it answers.

Structural changes (navigation, a component appearing/disappearing) fall
back to a full `<event>SURFACE_UPDATED</event>` re-sync (`kind:
'surfaceUpdated'`, the whole tree) because a value delta can't convey new
structure. Value changes ride a compact `kind: 'clientDataModel'` payload
carrying only the changed entries.

`intervalMs` is the poll cadence (polling only *detects* a change; it doesn't
deliver on its own). `settleMs` is how long a value must hold steady before
it's delivered, so mid-typing values ("Joh" → "John") coalesce into one
delivery. Keep `intervalMs` below `settleMs` for fine settle resolution.

> **Cheap deltas are automatic.** Value-bearing inputs path-bind their value
> into the data model out of the box, so a keystroke changes only the data
> model, not the structure — keeping `'sync'`-mode delivery on the cheap delta
> path. The binding key is the input's `fieldName` when given, otherwise its
> auto-assigned component id, so this holds even for inputs with no explicit
> `fieldName`. (The value is only inlined as a literal in the component tree
> when an input is rendered outside any surface — i.e. nothing the agent
> watches — so it never costs a per-keystroke re-sync in practice.)
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
turn. Requires `capabilities.canInitiateTurn`; on transports that can't
start their own turn it falls back to `'sync'` with a console warning.

**`mode: 'piggyback'`** is a deprecated alias for `'sync'` (the old
implementation flushed the full tree on the user's first transcript chunk,
which on Gemini Live arrives at turn-close and interrupted the answer). The
name still works; it resolves to `'sync'`.

Whether any mode does anything is still decided per-surface: a surface with
`surfaceWatch: false` is never watched.

## Testing

For deterministic, network-free tests, use the built-in
`ScriptedTransport` — a queue of programmed model reactions:

```ts
import { Agent, ScriptedTransport } from 'a2ui-svelte/agent';

const transport = new ScriptedTransport([
  { on: 'save it', calls: [{ name: 'click_button', args: { element_id: 'save-btn' } }], text: 'Saved.' }
]);
const agent = new Agent({ instructions: 'persona', surfaces: () => fixtures }, transport);
await agent.start();
agent.sendTextMessage('please save it');
// assert the action ran, the tool result echoed, the transcript updated…
```

For finer control, write a stub transport that emits synthetic events —
implement `AgentTransport`, return a `capabilities` object matching the
profile you want to exercise (the agent's gates key off it), and re-emit
events from your test. The library's own `agent.test.ts` defines
`MockAgentTransport` this way; note that if your mock advertises
`'audio'` modalities, the agent will try to construct the mic recorder /
speaker player, so tests in jsdom should either stub
`./audio-recorder`/`./audio-player` or advertise text-only modalities.

## Extending the agent

The extension axis is the **transport** (new providers, wrappers like
STT/TTS-around-text) and the **definition** (instructions, prompt
override via `buildPrompt`, watch tuning; guardrails and subagents are
planned to land here as uniform mechanics). The shell extends through
its snippet slots or `headless` mode. Subclassing `Agent` is **not**
supported — wrap, don't subclass.

## Pitfalls

- **Stale surfaces in `surfaces()` callback.** The callback is invoked
  whenever the agent needs the live surface state — on every poll tick and at
  each idle flush in `'sync'` mode, and on every timer tick in `'proactive'`
  mode (see `surfaceWatchTuning`). If your store is paused or memoised
  incorrectly, the agent acts on stale JSON. Always read live state.
- **Forgetting `agent.stop()` on `onDestroy`.** Hot reload leaks
  recorder instances. Always tear down.
- **Sending text before connecting.** `agent.sendTextMessage` while
  `agent.connected === false` is a no-op with a console warning. The
  default `<AgentShell>` lazy-starts the session on the first send; if you
  build your own UI, do the same or check `agent.connected` first.
- **Pico-less projects forgetting `renderer/styles.css`.** The shell
  CSS lives there; without it, the bottom bar will look unstyled.

## A2A (network) integration mode

`AgentTransport` covers model APIs where this library owns the agent and
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
