# Implementation Plan — Transport-neutral agent framework (voice **and** text models)

**Status:** WP1–WP5 and WP9 (unified framework) **DONE**; WP6 (behaviour test
tier) and WP8 (Anthropic provider) remain open
**Owner:** (per work package)
**Related:**
- `src/lib/voice/agent.svelte.ts` (the orchestrator being generalised)
- `src/lib/voice/transport.ts` (the interface being generalised)
- `docs/implementation_plans/surface-data-model-sync.md` (the surface-sync engine this plan must not regress)
- `docs/implementation_plans/voice-token-cost-and-mitigations.md` (token-cost context; relevant to the text transport's prompt caching)

> This document is **self-contained**. Each work package (WP) can be picked up
> in a cold session that has read only this file plus the handful of source
> files the WP names. Read **§0.5 (Revision 2)** and §1–§3 first (shared
> context + contracts), then your WP in §4.

---

## 0.5. Revision 2 (2026-06-10) — the unified framework. **READ THIS FIRST.**

WP1–WP5 landed the neutral layer but left the package with a split personality:
`VoiceAgent`+`VoiceShell` in `a2ui-svelte/voice` for audio, `Agent`+a chat
shell in `a2ui-svelte/agent` for text. A consumer had to pick the right *class*
and the right *shell* for their transport — which is exactly the
identity-branching this plan exists to eliminate, just pushed up into user
code. WP9 removed the split. **The library now ships ONE agent, ONE transport
contract, and ONE shell:**

- **`Agent`** (`a2ui-svelte/agent`) — the only orchestrator.
  `new Agent(definition, transport)`: the **`AgentDefinition`** (instructions,
  surfaces, context, mode, watch tuning, debug — and, in the future, guardrails
  / subagents) is a plain shareable object that never mentions a model; the
  transport is the second argument. Audio I/O (mic recorder, speaker player,
  `muted`/`toggleMute`, `recording`) lives in `Agent` itself, spun up **iff**
  `transport.capabilities.input`/`output` include `'audio'`. `VoiceAgent` is
  gone.
- **`AgentTransport`** — the only transport contract. `sendAudioChunk?` is an
  optional member (like `sendContextUpdate?`), and `audio-out` / `interrupted`
  are part of the shared event map (emitted only by transports whose
  capabilities include them). `VoiceTransport` is gone. **Auth belongs to the
  transport:** each implementation takes its credential in its own constructor
  (`GeminiLiveTransport({ token })`, `GeminiTextTransport({ apiKey | baseUrl })`)
  and `Agent` lost `mintToken`; `AgentTransportConnectOptions` lost
  `token`/`providerOptions`/`voice`.
- **`<AgentShell>`** — the only shell. A uniform chat bar (transcript peek,
  expandable history, text input, status, debug box) that grows the mic + mute
  cluster exactly when `agent.capabilities.input` includes `'audio'`.
  `VoiceShell` and the interim `ChatShell` are gone.
- **`a2ui-svelte/agent/gemini`** — both Gemini transports side by side:
  `GeminiLiveTransport` (renamed from `GeminiTransport`, streaming
  audio-to-audio) and `GeminiTextTransport` (request/response), plus
  `mintGeminiToken`. The `./voice` and `./voice/gemini` exports are deleted.

**Why this shape holds up:** a future "voice over a text model" feature is a
*transport decorator* — wrap a text transport with STT/TTS, advertise `'audio'`
in its capabilities, and the same `Agent` and the same `<AgentShell>` light up
the mic with zero changes. The capability descriptor, not the class hierarchy,
is the extension axis.

**Breaking changes shipped by WP9** (pre-1.0, deliberate — §6's back-compat
requirement is repealed for this revision):

| Was | Is |
|---|---|
| `import { VoiceAgent, VoiceShell } from 'a2ui-svelte/voice'` | `import { Agent, AgentShell } from 'a2ui-svelte/agent'` |
| `import { GeminiTransport, mintGeminiToken } from 'a2ui-svelte/voice/gemini'` | `import { GeminiLiveTransport, mintGeminiToken } from 'a2ui-svelte/agent/gemini'` |
| `new Agent({ transport, systemInstruction, mintToken, … })` | `new Agent({ instructions, … }, transport)` |
| `mintToken` option on the agent | token/apiKey on the transport constructor |
| `voice` option on `VoiceAgent` / connect opts | `voice` option on `GeminiLiveTransport` |
| `VoiceTransport` / `VoiceTransportEventMap` / `VoiceTransportConnectOptions` | `AgentTransport` / `AgentTransportEventMap` / `AgentTransportConnectOptions` |
| `'transcript-in'` / `'transcript-out'` deprecated alias events | removed — `'text-in'` / `'text-out'` only |
| `VoiceDebugStats` / `VoiceDebugStatsOptions` / `VoiceUsage` | `AgentDebugStats` / `AgentDebugStatsOptions` / `AgentUsage` |
| `ChatShell` (interim) | `AgentShell` |
| `AudioRecorder` / `AudioPlayer` from `a2ui-svelte/voice` | same classes from `a2ui-svelte/agent` |

§1–§3 below are kept as the **historical rationale** (the capability analysis
and the keystone event-loop idea are unchanged and still correct); where they
sketch `VoiceTransport`, a `voice/` module, or a `token` connect option, Revision
2 supersedes them. §8 (WP9 log) records what landed.

---

## 0. TL;DR

Today the agent framework is voice-shaped: `VoiceAgent` + `VoiceTransport` +
`VoiceShell`, built around Gemini Live's persistent bidi audio socket. But the
**core is already model-agnostic** (tool registry, action registry, processor,
surfaces, event bus) and the **orchestrator is ~95% channel-neutral** — only
~40 lines of audio I/O are truly voice-specific.

Goal: extract a **transport-neutral `Agent`** so the same instructions, tools,
surface-sync, user-actions, transcript, debug, and (future) guardrails/subagents
run over **either** a voice-native streaming transport (Gemini Live, unchanged)
**or** a request/response text transport (a Google text model such as
`gemini-3.5-flash`, reusing the `@google/genai` SDK already in the tree; Claude
and others are added later as alternative providers — see WP8). This unlocks the
real motivation: **text-based agent tests** that ask an agent to manipulate test
surfaces and assert on the result.

**The keystone idea:** a request/response transport drives the agentic tool-loop
*internally* and emits the **same events** a voice transport does (`tool-call`,
`text-out`, `turn-complete`, …). So the orchestrator never learns who ran the
loop, and it is genuinely shared — not two code paths in a trenchcoat.

**We do NOT flatten voice to STT→text→TTS.** The abstraction is at the
event/capability layer. Voice keeps its native bidi audio, server-driven loop,
barge-in, and silent-context channel. Text gets a clean client-driven loop. A
`TransportCapabilities` descriptor lets the shared orchestrator do the right
thing per transport.

**One package, not two.** New neutral modules under `a2ui-svelte/agent`;
`a2ui-svelte/voice` is kept and `VoiceAgent` becomes a thin subclass — existing
consumers are unaffected.

---

## 1. Background — current architecture (read this once)

### 1.1 Layers, by how channel-specific they actually are

**Already channel-neutral (no change):**
- `src/lib/core/registries/tool-registry.ts` — `{name, description, parameters(JSON schema), execute}`. `getDeclarations()` returns `{name, description, parameters}` — the universal tool shape, despite the "Gemini-format" comment.
- `src/lib/core/registries/event-bus.ts` — `userActionBus` (UI→agent events).
- `src/lib/core/registries/action-registry.ts` — element action callbacks (`click_button`/`update_text_field` dispatch).
- `src/lib/core/processor.ts` — applies `surfaceUpdate`/`beginRendering`/`dataModelUpdate`.
- `serializer.ts`, `state.svelte.ts`, `client-data-model.ts`, `extensions.ts` — surface state + extension flags.

**Neutral but currently filed under `voice/`:**
- `src/lib/voice/prompt-builder.ts` — pure block functions: system instruction + static surfaces + dynamic surfaces + tools + context + history. The structure is universal; only `historyBlock` carries a voice assumption (see §1.3).
- Most of `src/lib/voice/agent.svelte.ts`: prompt assembly, tool-declaration assembly (`#assembleToolDeclarations`), tool dispatch (`#handleToolCall`), the surface-sync engine (`#syncTick`/`#proactiveTick`/`#deliverSync`/…), `userActionBus` wiring, transcript state, status + thinking-watchdog, debug telemetry.

**Genuinely voice-specific:**
- `VoiceTransport` (`src/lib/voice/transport.ts`): `sendAudioChunk`; events `audio-out`, `interrupted`. (The `transcript-in`/`transcript-out` events are just **text-in/text-out** produced by ASR/TTS.)
- `VoiceAgent`: `#recorder`/`#player`, `muted`/`toggleMute`, the `audio-out` handler, and the recorder→`sendAudioChunk` wiring in `start()`.
- `src/lib/voice/VoiceShell.svelte`: the mic UI.

### 1.2 The one deeply voice-shaped thing: the turn lifecycle

| | Voice-native (Gemini Live) | Text model (Gemini text, Claude, …) |
|---|---|---|
| Session | persistent bidi socket | request/response |
| Who runs the tool loop | **the server** — emits tool calls, you reply, it continues | **the client** — send, get tool_use, execute, resend, repeat |
| History | ephemeral, re-injected as a prompt block | client-owned `messages[]`, resent each call (cacheable) |
| Interruption | barge-in is real | none |
| "Silent context" channel | native (`sendClientContent turnComplete:false`) | "append to the next user message" |

Almost all the subtle machinery in `VoiceAgent` — `#modelTurnActive`, the
`status === 'thinking'` gate in `#syncTick`, the whole "never deliver while
generating or you barge-in-interrupt" design — exists **only because of barge-in
on a streaming session**. A text model has none of it, so the text path is
*simpler*. We keep the gates and make them conditional on
`capabilities.interruptible`.

### 1.3 History handling, the one prompt-builder subtlety

- Voice-live: the session is ephemeral, so `historyBlock` embeds the last ~30
  turns into the **system prompt** for reconnect continuity. During a session
  the server holds the running context; the agent's `transcript` is for UI.
- Text: there is no separate session — each call resends `messages[]`. The
  **transport** owns the wire-level `messages[]` (it must, for the loop +
  `tool_result` batching). The agent's `transcript` stays the UI-facing view.
  So for text we **omit** `historyBlock` from the prompt and instead seed the
  transport's `messages[]` from prior turns via connect options.

### 1.4 Existing test harness pattern (reuse it)

`src/lib/voice/agent.test.ts` already defines `MockTransport implements
VoiceTransport`, drives `emit('tool-call', …)`, and asserts on surface state and
on what reached the transport. This is the template for the neutral test tiers
in WP6. Vitest runs in `jsdom` (`vite.config.ts`), tests are
`src/**/*.{test,spec}.ts`, and Svelte runes require `flushSync()` between an act
and its assertion.

---

## 2. Target architecture

### 2.1 Module layout (current, post-WP9)

```
a2ui-svelte/core            (unchanged — the brain stem)
a2ui-svelte/agent           THE framework (one layer, no voice/ module)
  agent/transport.ts          AgentTransport (incl. optional sendAudioChunk),
                              TransportCapabilities, event map (incl. audio-out
                              + interrupted), AgentUsage
  agent/agent.svelte.ts       Agent + AgentDefinition (one orchestrator;
                              capability-gated audio I/O)
  agent/AgentShell.svelte     THE shell (chat bar + capability-gated mic/mute)
  agent/DebugBox.svelte       shared debug panel
  agent/prompt-builder.ts     pure prompt blocks, history optional
  agent/debug.svelte.ts       AgentDebugStats telemetry
  agent/audio-recorder.ts     mic capture (used by Agent when input has audio)
  agent/audio-player.ts       speaker playback (used when output has audio)
  agent/scripted-transport.ts ScriptedTransport (deterministic, no model)
  agent/index.ts
a2ui-svelte/agent/gemini    both Gemini transports + the token minter
  agent/gemini/live-transport.ts  GeminiLiveTransport (bidi Live socket, audio)
  agent/gemini/text-transport.ts  GeminiTextTransport (generateContentStream)
  agent/gemini/token-handler.ts   mintGeminiToken (server-side)
  agent/gemini/index.ts
a2ui-svelte/agent/anthropic (LATER, WP8) Claude request/response transport
  agent/anthropic/transport.ts
  agent/anthropic/index.ts
```

### 2.2 Layer responsibilities

- **`AgentDefinition`:** what the agent *is* — instructions, surface sources,
  context, mode, watch tuning, debug; later guardrails/subagents. A plain
  object, declared once, valid for every transport.
- **`Agent`:** the definition connected to a transport. Owns prompt assembly,
  tool assembly + dispatch, the surface-sync engine, `userActionBus`
  subscription/forwarding, transcript, status/watchdog, debug, the lifecycle
  (`start`/`stop`/`toggle`/`reset`/`sendTextMessage`), **and the audio I/O**
  (recorder/player/mute) — created iff the capabilities advertise the
  modality. Talks only to `AgentTransport`; never branches on identity.
- **`AgentTransport`:** the per-model adapter. Presents a uniform event stream
  regardless of whether the loop runs server-side (voice) or client-side
  (text); owns its own auth (constructor credential, resolved in `connect()`).
- **`<AgentShell>`:** the one UI, bound to `agent.transcript` /
  `agent.sendTextMessage` / `agent.status` / `agent.debug`; reads
  `agent.capabilities` to add the mic + mute cluster on audio transports.

---

## 3. Shared contracts (every WP depends on these)

> **Revision 2 note:** these sketches are the WP1-era originals. The shipped
> contracts differ as §0.5 describes: no `token`/`providerOptions` in connect
> options (auth is the transport constructor's), `sendAudioChunk?` is an
> optional member of `AgentTransport` itself, `audio-out`/`interrupted` are in
> the shared event map, and there is no `VoiceTransport` sub-interface. Read
> `src/lib/agent/transport.ts` for the authoritative shapes.

These are the canonical type sketches. WP1 lands them; later WPs consume them.
Field names are chosen to minimise churn vs today's `VoiceTransport`.

### 3.1 Capabilities

```ts
// agent/transport.ts
export interface TransportCapabilities {
  /** Persistent bidi session (voice) vs request/response (text). */
  streaming: boolean;
  /** Barge-in possible. When false, the surface-sync barge-in gates are bypassed. */
  interruptible: boolean;
  /** Has a real silent-context channel (sendContextUpdate). */
  silentContext: boolean;
  /**
   * 'server' — the live session holds history (voice); the agent embeds prior
   *            turns in the system prompt (historyBlock).
   * 'client' — the transport owns messages[]; the agent omits historyBlock and
   *            seeds prior turns via connect opts (`history`).
   */
  historyOwnership: 'server' | 'client';
  /**
   * Can the transport start a model turn on its own (without a user message)?
   * Needed by surface-watch 'proactive' mode. Voice: true. Text: typically
   * false unless the transport implements an autonomous kick.
   */
  canInitiateTurn: boolean;
  input: Array<'audio' | 'text'>;
  output: Array<'audio' | 'text'>;
}
```

### 3.2 Neutral transport interface

```ts
// agent/transport.ts
export interface AgentTransport {
  readonly capabilities: TransportCapabilities;

  connect(opts: AgentTransportConnectOptions): Promise<void>;

  /** A user turn (also used for tagged events when sendUserAction is absent). */
  sendText(text: string): void;

  /** Append to context without provoking a turn. Optional capability. */
  sendContextUpdate?(text: string): void;

  /** Reply to a tool call. result must be JSON-serialisable. */
  sendToolResult(callId: string, name: string, result: unknown): void;

  /** Forward a spec-canonical userAction natively (optional). */
  sendUserAction?(action: UserAction): void;

  on<E extends keyof AgentTransportEventMap>(
    event: E, handler: (p: AgentTransportEventMap[E]) => void
  ): () => void;

  close(): void;
}

export interface AgentTransportConnectOptions {
  token: string;
  systemInstruction: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /**
   * Prior conversation turns to seed history. The agent supplies this ONLY when
   * capabilities.historyOwnership === 'client' (text); voice ignores it and the
   * agent embeds history in the prompt instead.
   */
  history?: Array<{ role: 'user' | 'model'; text: string }>;
  providerOptions?: Record<string, unknown>;
}

export interface AgentTransportEventMap {
  'tool-call': { calls: Array<{ id: string; name: string; args: Record<string, unknown> }> };
  /** Model-produced text (streaming delta or whole turn). Voice: TTS transcript. */
  'text-out': { text: string };
  /** User-produced text (streaming delta or whole turn). Voice: ASR transcript. */
  'text-in': { text: string };
  'turn-complete': Record<string, never>;
  'error': { message: string; cause?: unknown };
  'close': { reason?: string };
  'usage': AgentUsage;
}

// Renamed from VoiceUsage; keep `VoiceUsage` as a type alias export for back-compat.
export interface AgentUsage { /* identical to today's VoiceUsage */ }
```

### 3.3 Voice transport = neutral + audio

```ts
// voice/transport.ts
export interface VoiceTransport extends AgentTransport {
  /** Send a 16-bit LE PCM @16kHz chunk, base64. */
  sendAudioChunk(base64Pcm16k: string): void;
}
export interface VoiceTransportEventMap extends AgentTransportEventMap {
  'audio-out': { base64Pcm24k: string };
  'interrupted': Record<string, never>;
}
export interface VoiceTransportConnectOptions extends AgentTransportConnectOptions {
  voice?: string;
}
// Back-compat: re-export VoiceUsage = AgentUsage. Optionally keep
// 'transcript-in'/'transcript-out' as deprecated aliases if any external code
// listens for them (internal code migrates to text-in/text-out).
```

---

## 4. Work packages

Each WP states: **Objective · Prereqs · Read first · Changes · Acceptance ·
Out of scope.** Acceptance always includes `pnpm check` and `pnpm test` green
unless stated.

---

### WP1 — Neutral transport contract + capabilities

> **Status: ✅ DONE** (2026-06-07, branch `feat/transport-neutral-agent-wp1`).
> `pnpm check` 0 errors, `pnpm test` 117/117 green. See the Progress log (§8)
> for what landed and the gotchas WP2–WP4 should know.

**Objective:** Introduce the neutral `AgentTransport` / `TransportCapabilities`
/ event map / `AgentUsage`; refactor `VoiceTransport` to extend it; teach
`GeminiTransport` (and the test `MockTransport`) to advertise capabilities and
emit the renamed text events. **Pure refactor — zero behaviour change.**

**Prereqs:** none (foundational).

**Read first:** `src/lib/voice/transport.ts`, `src/lib/voice/gemini/transport.ts`,
`src/lib/voice/agent.svelte.ts` (only the transport-event wiring in `start()`),
this doc §3.

**Changes:**
1. Create `src/lib/agent/transport.ts` with §3.1–§3.2 contracts. Move the
   `VoiceUsage` body here as `AgentUsage`.
2. Rewrite `src/lib/voice/transport.ts`: `VoiceTransport extends AgentTransport`
   (adds `sendAudioChunk`), `VoiceTransportEventMap extends AgentTransportEventMap`
   (adds `audio-out`, `interrupted`), `VoiceTransportConnectOptions extends
   AgentTransportConnectOptions` (adds `voice`). Re-export `AgentUsage` as
   `VoiceUsage`.
3. `GeminiTransport`:
   - add `get capabilities(): TransportCapabilities` →
     `{ streaming:true, interruptible:true, silentContext:true,
        historyOwnership:'server', canInitiateTurn:true,
        input:['audio','text'], output:['audio','text'] }`.
   - rename emitted `transcript-out`→`text-out`, `transcript-in`→`text-in`.
4. `VoiceAgent` (`agent.svelte.ts`): update the two listeners
   (`transcript-out`→`text-out`, `transcript-in`→`text-in`). No other change.
5. `agent.test.ts` `MockTransport`: add a `capabilities` getter (voice profile)
   and update any `transcript-*` emits to `text-*`.
6. Create `src/lib/agent/index.ts` exporting the transport types. Add the
   `./agent` export to `package.json`. Keep `voice/index.ts` re-exporting the
   types it exposes today (alias where renamed).

**Acceptance:**
- `pnpm check` + `pnpm test` green (the existing voice suite is the regression
  net — it must pass unchanged in behaviour).
- `VoiceTransport` is structurally `AgentTransport` + audio; `GeminiTransport`
  satisfies both.
- No `transcript-in`/`transcript-out` string remains in internal code paths
  (grep), except optional deprecated aliases.

**Out of scope:** extracting the `Agent` base (WP2); any text transport.

---

### WP2 — Extract the neutral `Agent` base; `VoiceAgent` becomes a subclass

**Objective:** Move everything channel-neutral out of `VoiceAgent` into a new
`Agent` base in `src/lib/agent/agent.svelte.ts`; leave only audio I/O + mute in
`VoiceAgent extends Agent`. Make the barge-in gates and the poll loop conditional
on `transport.capabilities`.

**Prereqs:** WP1.

**Read first:** the whole of `src/lib/voice/agent.svelte.ts` (this is the
delicate one), `src/lib/voice/debug.svelte.ts`, this doc §1.2 and §3.

**Changes:**
1. Create `src/lib/agent/agent.svelte.ts` with class `Agent`. Move in, verbatim
   where possible: prompt assembly (`#buildPrompt`, `#assembleToolDeclarations`),
   tool dispatch (`#handleToolCall`), the **entire surface-sync engine**
   (`#startSurfaceWatch`/`#stopSurfaceWatch`/`#syncTick`/`#proactiveTick`/
   `#deliverSync`/`#deliverFullSurface`/`#deliverDataModelDelta`/`#sendSilently`/
   snapshots/deltas/`#markAllDelivered`/…), `userActionBus` wiring
   (`#handleUserAction`), transcript handling (`#onTextOut`/`#onTextIn`/
   `#onTurnComplete`), status + thinking-watchdog, debug (`#rec`), and the
   reactive `$state` fields that are not audio (`connected`, `status`,
   `transcript`, `hasStarted`, `configIssue`, `debug`).
2. **Generalise the lifecycle:** `Agent.start()` does mint-token → assemble tools
   → build prompt → `transport.connect()` → wire **common** events (`tool-call`,
   `text-out`, `text-in`, `turn-complete`, `error`, `close`, `usage`) → subscribe
   `userActionBus` → start surface watch. Provide protected hooks for subclasses:
   - `protected async startInput(): Promise<void>` (no-op in base; voice starts
     the recorder),
   - `protected stopInput(): void` (no-op; voice stops recorder/player),
   - `protected wireExtraTransportEvents(): void` (no-op; voice wires `audio-out`
     + `interrupted` and pushes the unsubs).
   `Agent.start()` calls `wireExtraTransportEvents()` then `await startInput()`
   before flipping `connected = true`.
3. **Conditional behaviour from capabilities:**
   - The `text-out` handler already sets `#modelTurnActive = true` — keep (covers
     text streaming and voice TTS alike).
   - In `#syncTick`, gate on `#modelTurnActive`/`thinking` **only when**
     `capabilities.interruptible`. When not interruptible, the tick may deliver
     freely.
   - In `#startSurfaceWatch`, start the poll timer **only when**
     `capabilities.streaming`. For non-streaming transports rely on the existing
     pre-turn flush (`#syncDataModel()` already called in `sendTextMessage()` and
     `#handleUserAction()`), which covers the "model sees current UI before it
     answers" requirement without a timer.
   - `'proactive'` mode requires `capabilities.canInitiateTurn`; if a transport
     lacks it, log a warning and fall back to `'sync'`.
   - History routing: in `#buildPrompt`, include the history block only when
     `capabilities.historyOwnership === 'server'`. When `'client'`, pass
     `history: this.transcript` (filtered/sliced) into `transport.connect()` via
     `AgentTransportConnectOptions.history` and omit `historyBlock`.
4. Rewrite `src/lib/voice/agent.svelte.ts`: `class VoiceAgent extends Agent`.
   Keep only: `recording`/`muted` `$state`, `toggleMute()`, `#recorder`/
   `#player`, `startInput()`/`stopInput()` overrides (recorder/player setup +
   teardown, the muted-drop logic in the recorder `data` handler), and
   `wireExtraTransportEvents()` (audio-out → player + `#modelTurnActive=true` +
   `#onModelActivity`; interrupted → stop player + thinking). Add `voice?` to
   the options and pass it through `connect()`. Re-export everything
   `voice/index.ts` exports today.
5. Move `debug.svelte.ts` → `agent/debug.svelte.ts`; re-export from
   `voice/index.ts` and `voice/debug.svelte.ts` shim if needed. (The audio debug
   kinds stay; text transports simply never record them.)
6. Split tests: keep voice-specific cases (mute, audio) in `voice/agent.test.ts`;
   move channel-neutral cases (tool dispatch, surface-sync sync/proactive,
   userAction, watchdog, debug) into `agent/agent.test.ts` running against a
   neutral mock with a **voice-profile capabilities** object (so they exercise
   the same gated paths). Both suites green.

**Acceptance:**
- `pnpm check` + `pnpm test` green; **every existing voice behaviour preserved**
  (mute drops audio; sync deltas/full-resync; proactive settle/cooldown;
  no-echo-of-own-write; watchdog self-heal; userAction native vs wrapped).
- `VoiceAgent` contains no surface-sync / prompt / tool-dispatch logic — only
  audio + mute + the overrides.
- A neutral mock transport with `interruptible:false, streaming:false` drives a
  tool call and a pre-turn surface sync end-to-end (smoke test in
  `agent/agent.test.ts`).

**Out of scope:** the Anthropic transport; shells. Keep guardrails/subagents
**out** (just leave clearly-named extension points, §4 WP7 note).

---

### WP3 — Generalise the prompt-builder (move + history optional)

> **Status: ✅ DONE** (2026-06-07, branch `feat/transport-neutral-agent-wp1`).
> `pnpm check` 0 errors, `pnpm test` 128/128, `pnpm package`/publint clean. See §8.

**Objective:** Move `prompt-builder.ts` to `agent/` and make history optional so
client-history transports omit it. Pure-function change.

**Prereqs:** WP1 (types). Can land in parallel with WP2; coordinate the
`#buildPrompt` history-routing change (it belongs to WP2 — this WP only changes
the builder).

**Read first:** `src/lib/voice/prompt-builder.ts`, this doc §1.3.

**Changes:**
1. Move file → `src/lib/agent/prompt-builder.ts`. Re-export from
   `voice/index.ts` and (if any external import exists) a
   `voice/prompt-builder.ts` shim, to preserve back-compat.
2. Make `PromptInputs.transcriptHistory` optional / allow `includeHistory:
   boolean`. `buildSystemPrompt` omits `historyBlock` when history is empty/
   excluded. No content change to the other blocks.
3. Export from `agent/index.ts`.
4. Update/keep prompt snapshot expectations if any exist.

**Acceptance:** `pnpm check` + `pnpm test` green; building a prompt with
`includeHistory:false` produces no "Recent Conversation History" block;
voice prompt output is byte-identical to before when history is included.

**Out of scope:** the agent-side decision of *when* to include history (WP2).

---

### WP4 — `ScriptedTransport` + first text transport (`GeminiTextTransport`)

> **Status: ✅ DONE** (2026-06-07, branch `feat/transport-neutral-agent-wp1`).
> `pnpm check` 0 errors, `pnpm test` 138 pass + 1 skipped (live),
> `pnpm package`/publint clean, **no new dependency**. Re-scoped from Anthropic
> to Gemini text before implementation — Anthropic is now WP8. See §8 for the
> gotchas WP6/WP8 should know.

**Objective:** Provide (a) a deterministic, model-free `ScriptedTransport` for CI
tests, and (b) a real `GeminiTextTransport` that drives the agentic loop
client-side over a Google **text** model (request/response — *not* the Live
socket) and emits the neutral event stream. This is the package that makes "one
framework" real, and it reuses the `@google/genai` SDK already in the tree (no
new dependency). Claude is added later as an alternative provider — see WP8.

**Why Gemini text first:** the library already targets Google models (Gemini Live
for voice), so the cheapest way to validate the text path is the same provider's
request/response API. The voice `GeminiTransport` already passes our universal
tool shape (`{name, description, parameters}`) straight into `functionDeclarations`
and already maps `functionResponse`s back — the text transport is the same
translation against `ai.models.generateContentStream` instead of `ai.live`.

**Prereqs:** WP1 (types), WP2 (Agent base). WP3 helps but isn't strictly
required.

**Read first:** this doc §0 (keystone), §1.2, §3; `src/lib/voice/gemini/transport.ts`
(the shape reference — same SDK, same tool/`functionResponse` mapping, Live
instead of request/response). Model IDs: default the text model to
`gemini-3.5-flash` (configurable via `providerOptions.model`); the Live voice
model stays `gemini-3.1-flash-live-preview`, untouched.

**Changes:**

**(a) `src/lib/agent/scripted-transport.ts`** — `ScriptedTransport implements
AgentTransport`:
- capabilities `{ streaming:false, interruptible:false, silentContext:false,
  historyOwnership:'client', canInitiateTurn:false, input:['text'],
  output:['text'] }`.
- Constructed with a script: a list of programmed model reactions keyed by turn,
  e.g. `[{ on: /add .* waiter/, calls: [{name:'update_text_field', args:{…}}] },
  …]` or a simpler "queue of reactions" the test pushes. On `sendText`, look up
  the next reaction → emit `tool-call` (synchronously or on a microtask) → on
  the matching `sendToolResult` count, emit any follow-up `text-out` + `turn-
  complete`. No network. This is the deterministic test tier.

**(b) `src/lib/agent/gemini/transport.ts`** — `GeminiTextTransport implements
AgentTransport`:
- capabilities `{ streaming:false, interruptible:false, silentContext:false,
  historyOwnership:'client', canInitiateTurn:false, input:['text'],
  output:['text'] }`. (Output text *streams* as deltas via `text-out`, but the
  session is request/response, hence `streaming:false` — that flag means "live
  bidi session", not "token streaming".)
- `connect(opts)`: construct `new GoogleGenAI({ apiKey: opts.token })`; store
  `systemInstruction`; map `opts.tools` (already `{name, description, parameters}`)
  into `config.tools = [{ functionDeclarations: opts.tools }]` verbatim — the
  same passthrough the voice transport does; seed the client-owned `contents[]`
  from `opts.history` (`{ role:'user'|'model', parts:[{text}] }`); model from
  `providerOptions.model` (default `gemini-3.5-flash`).
- `sendText(text)`: push `{role:'user', parts:[{text}]}` to `contents[]`, then
  run the loop:
  1. call `ai.models.generateContentStream({ model, contents, config })`. For
     each chunk, emit `chunk.text` as a `text-out` delta.
  2. Collect the turn's `functionCall` parts. If any, append the model turn
     (`{role:'model', parts:[…functionCall parts]}`) to `contents[]`, emit
     **one** `tool-call` event with **all** calls
     (`{ id: <synthesised>, name: fc.name, args: fc.args }`), and set a pending
     counter = number of calls.
  3. `sendToolResult(callId, name, result)`: buffer a
     `{ functionResponse: { id, name, response: result } }` part. When the buffer
     reaches the pending count, append `{role:'user', parts:[…responses]}` to
     `contents[]` and **re-call** (back to step 1).
  4. When a turn ends with no `functionCall` (final text), emit `turn-complete`.
     Map `response.usageMetadata` → `AgentUsage` (`promptTokenCount`,
     `candidatesTokenCount`→`responseTokenCount`, `totalTokenCount`,
     `cachedContentTokenCount`) and emit `usage`.
- `sendContextUpdate` is **omitted** (no silent channel; the agent falls back to
  attaching surface state to the next `sendText`, which WP2 already handles for
  non-streaming transports).
- `sendUserAction` may be omitted (agent wraps it into a text turn — existing
  fallback).
- `close()`: set a `closed` flag that the loop checks between chunks/re-calls so
  an in-flight stream is abandoned; idempotent. Emit `error` on SDK failures
  (normalised message).
- `src/lib/agent/gemini/index.ts` exports it. Add `./agent/gemini` to
  `package.json` exports. **No new dependency** — `@google/genai` is already
  present.

**Key correctness points (call out in code comments):**
- Parallel tool calls: a Gemini turn can contain multiple `functionCall` parts →
  emit them as one `tool-call` with N calls (the agent already iterates
  `calls[]`). All N `functionResponse`s must go in the **next single** `user`
  content before re-calling — hence the pending-counter batching.
- **Function calls in the request/response API may not carry a stable `id`**
  (unlike Gemini Live, which sends `fc.id`). Synthesise one
  (e.g. `${fc.name}-${turn}-${i}`) for the neutral `tool-call` event, keep a
  per-turn map back to the call, and match `functionResponse`s by **name** — do
  not rely on the agent echoing a wire id. (The agent calls `sendToolResult`
  with the id we emitted, so a per-turn map is enough.)
- The agent's `#handleToolCall` runs `surfaceUpdate`/`beginRendering`/
  `dataModelUpdate` through `processMessage` and other tools through
  `toolRegistry` — unchanged; the transport only needs the result echoed back.

**Acceptance:**
- `pnpm check` green; new unit tests:
  - `ScriptedTransport`: an `Agent` + scripted reaction drives a `click_button`
    on a test surface and the surface state changes; assert no network.
  - `GeminiTextTransport`: a unit test with `@google/genai` **mocked** (no live
    calls) verifying: tool passthrough into `functionDeclarations`; one
    `tool-call` emitted for two `functionCall` parts; re-call happens only after
    both `functionResponse`s; `text-out` deltas stream; `turn-complete` on
    final; `usageMetadata` mapped to `AgentUsage`.
- A **live** smoke test exists but is gated behind an env var
  (`A2UI_LIVE_GEMINI=1` + `GEMINI_API_KEY`) so CI stays hermetic.

**Out of scope:** the Anthropic transport (WP8); the OpenAI transport (same
client-loop pattern, later); the test *suite* of agent behaviours (WP6).

---

### WP5 — Text/chat shell (UI)

> **Status: ✅ DONE** (2026-06-07, branch `feat/transport-neutral-agent-wp1`).
> `pnpm check` 0 errors, `pnpm test` 141 pass + 1 skip, `pnpm package`/publint
> clean. See §8.

**Objective:** A UI for text agents: a message list bound to `agent.transcript`
+ an input box calling `agent.sendTextMessage`, with the `status` badge. Prefer
extracting a shared headless core so voice and chat don't duplicate.

**Prereqs:** WP2 (the base `Agent` exposing `transcript`/`status`/
`sendTextMessage`).

**Read first:** `src/lib/voice/VoiceShell.svelte` (snippet-driven structure to
mirror).

**Changes:**
1. Add `agent/AgentShell.svelte`: props
   `{ agent: Agent }`, optional snippets (`messages`, `input`, `status`,
   `controls`) mirroring `VoiceShell`'s snippet API, a default message list +
   textarea + send button, and the same `debug` panel binding to `agent.debug`.
   No mic, no audio.
2. Optionally refactor the shared bits of `VoiceShell` (transcript rendering,
   debug box, text input form) into a headless helper both shells use — only if
   it reduces duplication without churning `VoiceShell`'s public API.
3. Export the shell; document in README under a new "Text agents" subsection
   (brief).

**Acceptance:** `pnpm check` + `pnpm test` green; a component test mounts
`AgentShell` with a mock `Agent`, types a message, asserts `sendTextMessage`
fired and a model transcript entry renders. `VoiceShell` API unchanged.

**Out of scope:** styling polish beyond parity with `VoiceShell`.

---

### WP6 — Agent behavioural test harness + surface-manipulation tests (the original goal)

**Objective:** Stand up the test tier this whole plan exists for: given test
surfaces with known component IDs, ask an agent (via `ScriptedTransport` for CI,
and optionally `GeminiTextTransport` live) to manipulate them and assert results.

**Prereqs:** WP2, WP4. (WP3/WP5 not required.)

**Read first:** `src/lib/voice/agent.test.ts` (harness pattern), `src/lib/core/
registries/{tool-registry,action-registry,event-bus}.ts`, `src/lib/core/
serializer.ts`, this doc §1.4.

**Changes:**
1. Create `src/lib/agent/__fixtures__/` with a couple of **generic** test
   surfaces (a small form: name/role TextFields + an "add" Button registering
   `update_text_field`/`click_button` actions; a static list). **Use neutral
   example domains only** — see [[no-souschef-in-public-repo]]: no private
   project names anywhere in tests/fixtures.
2. `agent/agent.behavior.test.ts` (deterministic, CI): build the fixtures +
   `Agent` + `ScriptedTransport`; script reactions for prompts like "add a
   waiter named Mario" → `update_text_field`+`click_button`; await
   `turn-complete`; assert the surface data model / action effects. Cover:
   tool dispatch result correctness, pre-turn surface sync attaching current UI,
   userAction round-trip, error tool result shape.
3. (Optional, gated) `agent/agent.live.test.ts` behind `A2UI_LIVE_GEMINI=1`:
   the same fixtures driven by a real Gemini text session via
   `GeminiTextTransport`, asserting the agent actually fills + submits. This is
   the eval tier. (An Anthropic-backed variant lands with WP8.)
4. Add an npm script note (e.g. document `A2UI_LIVE_GEMINI=1 pnpm test
   agent.live`) in the WP and/or README testing section.

**Acceptance:** `pnpm test` green and hermetic by default (no network); the
deterministic behaviour test demonstrably fails if surface mutation regresses;
the live test, when enabled with a key, passes against a real model.

**Out of scope:** a full eval framework / scoring harness (future).

---

### WP7 (future, not now) — Guardrails, subagents, callbacks

Not in this plan's scope, but the reason for putting tool dispatch + lifecycle
in the neutral `Agent`: these are turn-lifecycle hooks (`onBeforeToolCall`,
`onTurnComplete`, input/output guards, sub-agent spawning) that, once added to
the base, every transport inherits. **WP2 should leave clearly-named, empty
extension points** (or at least not foreclose them) but implement nothing.

---

### WP8 — Anthropic (`AnthropicTransport`) as an alternative text provider

**Objective:** Add Claude as a second request/response text provider, proving the
neutral layer is genuinely multi-provider. Same client-driven tool-loop shape as
`GeminiTextTransport` (WP4), against the Anthropic Messages API instead of
`@google/genai`. Purely additive — nothing else changes.

**Prereqs:** WP4 (the `GeminiTextTransport` establishes the client-loop pattern,
the text-profile capabilities, and the pending-counter tool-result batching this
mirrors). Independent of WP5/WP6.

**Read first:** WP4 (the pattern to mirror), this doc §3 and §6; **invoke the
`claude-api` skill** for the Anthropic SDK + prompt-caching idioms and current
model IDs.

**Changes:**
- `src/lib/agent/anthropic/transport.ts` — `AnthropicTransport implements
  AgentTransport`, text-profile capabilities (identical to WP4's).
  - `connect(opts)`: construct the SDK client from `opts.token` (API key) +
    optional `providerOptions.baseURL` (proxy); store `systemInstruction` as a
    `system` block with `cache_control: { type: 'ephemeral' }` (prompt caching —
    §6); map `opts.tools` → `{ name, description, input_schema }`; seed
    `messages[]` from `opts.history`. Model from `providerOptions.model`
    (current Claude model per the `claude-api` skill).
  - `sendText(text)`: the same loop as WP4 — stream `text` deltas as `text-out`;
    on `stop_reason === 'tool_use'`, append the assistant turn, emit **one**
    `tool-call` with **all** `tool_use` blocks (`{id, name, args:input}`), set a
    pending counter; `sendToolResult` buffers `{type:'tool_result',
    tool_use_id, content}` and re-calls once all are in. On final text emit
    `turn-complete` + map `usage` → `AgentUsage`.
  - `sendContextUpdate`/`sendUserAction` omitted (agent fallbacks, as WP4).
  - `close()`: abort in-flight stream; idempotent; normalise SDK errors to
    `error`.
- `src/lib/agent/anthropic/index.ts` exports it. Add `./agent/anthropic` to
  `package.json` exports and `@anthropic-ai/sdk` to dependencies.

**Key correctness points:** identical to WP4 (parallel `tool_use` → one
`tool-call` with N; all `tool_result`s in the next single user message before
re-calling). Anthropic *does* carry a stable `tool_use.id`, so unlike Gemini
text there's no id to synthesise — echo `block.id` straight through.

**Acceptance:**
- `pnpm check` green; a unit test with the SDK **mocked** mirroring WP4's:
  schema mapping; one `tool-call` for two `tool_use` blocks; re-call only after
  both `tool_result`s; `text-out` deltas; `turn-complete` on final; `usage`
  mapped; `system` carries `cache_control`.
- A **live** smoke test gated behind `A2UI_LIVE_ANTHROPIC=1` + `ANTHROPIC_API_KEY`.

**Out of scope:** OpenAI (same pattern); changing any shared code (this WP is
additive only).

**Revision-2 addendum:** implement against the post-WP9 contracts — no `token`
in connect options (take the API key in the constructor, mirroring
`GeminiTextTransportOptions.apiKey`), text-profile capabilities, and export
from `a2ui-svelte/agent/anthropic`.

---

### WP9 — Unified agent framework (one Agent, one transport contract, one shell)

> **Status: ✅ DONE** (2026-06-10, branch `feat/transport-neutral-agent-wp1`).
> `pnpm check` 0 errors, `pnpm test` 151 pass + 1 skip, `pnpm package`/publint
> clean, example app type-checks. See §0.5 for the design and the breaking-
> change table, and §8 for the landing notes.

**Objective:** Collapse the voice/text split left by WP1–WP5 into a single
framework: dissolve `VoiceAgent` into `Agent` (capability-gated audio I/O),
dissolve `VoiceTransport` into `AgentTransport` (optional audio members), merge
`VoiceShell`+`ChatShell` into one `<AgentShell>`, move auth into the
transports, separate the `AgentDefinition` from the transport in the `Agent`
constructor, consolidate everything under `a2ui-svelte/agent`(+`/gemini`), and
delete the `voice` module and exports.

---

## 5. Sequencing & parallelism

```
WP1 ─┬─> WP2 ─┬─> WP4 ─┬─> WP6
     │        │        ├─> WP8  (Anthropic alt-provider — mirrors WP4)
     └─> WP3 ─┘        └─> WP5  (WP5 needs only WP2)
```

- **WP1 is the gate** — everything depends on the contracts.
- **WP2 is the critical, delicate package** (surface-sync regression risk).
  Give it the most care and lean on the existing test suite.
- **WP3** can run in parallel with WP2 (pure functions) but coordinate the
  `#buildPrompt` edit, which lives in WP2.
- After WP2: **WP4 and WP5 are independent** and can run in parallel (different
  sessions / worktrees).
- **WP6** is last (needs WP4).
- **WP8** (Anthropic alt-provider) mirrors WP4's client-loop; it can land anytime
  after WP4, is purely additive, and blocks nothing.

**Can it be one-shot?** No — it's a multi-module refactor of finely-tuned code
plus a new SDK integration plus UI plus tests. Splitting as above keeps each
session within a safe context budget and each step independently verifiable
(`pnpm check` + `pnpm test`).

---

## 6. Cross-cutting constraints

- **Back-compat:** ~~mandatory~~ **repealed by WP9** (deliberate pre-1.0 break,
  see §0.5). There is no `voice` module to re-export from anymore; do not
  reintroduce aliases. From here on, `a2ui-svelte/agent` + `a2ui-svelte/agent/*`
  are the API surface to keep stable.
- **Don't regress the voice surface-sync.** The barge-in/settle/coalesce logic
  in `agent.svelte.ts` is the product of `surface-data-model-sync.md` and is
  subtle. Keep it intact; only *gate* it on capabilities. The voice test suite
  is the contract.
- **Token cost (text path).** Per [[voice-token-amplifiers]] /
  `voice-token-cost-and-mitigations.md`, dense surfaces are token amplifiers.
  `GeminiTextTransport` resends the surface-bearing system prompt + `contents[]`
  each loop iteration; Gemini's **implicit context caching** discounts the
  repeated static prefix automatically (no API change needed), so keep the
  system-prompt prefix stable and tool-result echoes lean to maximise cache
  hits. The Anthropic provider (WP8) gets the same effect explicitly via
  `cache_control` on the `system` block (the `claude-api` skill enforces caching
  by default).
- **Test hermeticity.** Default `pnpm test` must not hit the network. Live
  model tests are env-gated.
- **Generic examples only.** No private project names in any code/doc/test/
  fixture (`no-souschef-in-public-repo`).
- **Every WP ends green** on `pnpm check` and `pnpm test`, and commits on a
  branch (not `master`) with a conventional-commit message (`feat:`/`refactor:`).

## 7. Definition of done (whole feature)

- ✅ The same `Agent` (same `AgentDefinition`) drives Gemini Live (voice) and a
  Gemini text model (request/response) with shared instructions, tools,
  surface-sync, user-actions, transcript, debug. Adding a second text provider
  (Claude, WP8) is purely additive.
- ✅ One `<AgentShell>` serves every transport, adapting to
  `agent.capabilities` (mic/mute appear iff audio input is advertised).
- ⬜ A deterministic, hermetic agent-behaviour test suite manipulates test
  surfaces via `ScriptedTransport` (WP6); an env-gated live suite does the
  same via a Gemini text model.
- ✅ Exports: `a2ui-svelte/agent` and `a2ui-svelte/agent/gemini` (WP8 adds
  `a2ui-svelte/agent/anthropic`); README documents the unified framework.

## 8. Progress log

### WP1 — DONE (2026-06-07, branch `feat/transport-neutral-agent-wp1`)

**What landed:**
- New `src/lib/agent/transport.ts` (`AgentTransport`, `TransportCapabilities`,
  `AgentTransportConnectOptions` — now incl. optional `history` —
  `AgentTransportEventMap` with `text-out`/`text-in`, `AgentUsage`) and
  `src/lib/agent/index.ts` re-exporting them. Added `./agent` to `package.json`
  exports.
- `src/lib/voice/transport.ts` rewritten: `VoiceTransport extends AgentTransport`
  (+ `sendAudioChunk`), `VoiceTransportEventMap extends AgentTransportEventMap`
  (+ `audio-out`, `interrupted`), `VoiceTransportConnectOptions extends
  AgentTransportConnectOptions` (+ `voice`). `VoiceUsage` is now a deprecated
  alias of `AgentUsage`.
- `GeminiTransport` advertises `get capabilities()` (the voice profile) and emits
  the renamed `text-out`/`text-in`.
- `VoiceAgent` listeners migrated to `text-out`/`text-in`.
- `agent.test.ts` `MockTransport` got a voice-profile `capabilities` getter; test
  emits migrated to `text-*`.

**Decisions / deviations from the WP text (read before WP2–WP4):**
- **Kept `transcript-in`/`transcript-out` as deprecated aliases, not a pure
  rename.** The shipped skill (`src/lib/skills/integrate-voice-agent.md`) and
  `docs/guides/voice-integration.md` publicly document those event names, so
  external listeners plausibly exist → §6 back-compat applies. `GeminiTransport`
  therefore **dual-emits** (`text-out` + `transcript-out`, same for `-in`); both
  docs were updated to the new names with a deprecation note. Internal code
  (VoiceAgent, tests) uses only the `text-*` names. If a later WP wants to drop
  the aliases, do it as a deliberate breaking change with a version bump.

**Gotchas for downstream WPs:**
- **Sub-interface method redeclaration is mandatory, not optional.** Because
  `VoiceTransport extends AgentTransport`, it had to redeclare **both** `on`
  (over `VoiceTransportEventMap`) **and** `connect` (over
  `VoiceTransportConnectOptions`) — otherwise the inherited base signatures drop
  the `audio-out`/`interrupted` events and the `voice` connect option (the
  `'voice' does not exist in type 'AgentTransportConnectOptions'` error). Any
  future transport sub-interface that widens the event map or narrows the connect
  options must do the same. Method-syntax bivariance makes these overrides valid.
- **`src/lib/voice/agent.svelte.ts` contains a stray NUL byte**, so plain `grep`
  treats it as binary and silently prints nothing. Use `grep -a` (or ripgrep) on
  that file. WP2 edits it heavily — keep this in mind when searching it.
- The neutral layer imports `UserAction` from `../core/registries/event-bus`
  (same relative depth as `voice/`), so moving more code into `agent/` keeps that
  import path.

### WP2 — DONE (branch `feat/transport-neutral-agent-wp1`)

**What landed:**
- New `src/lib/agent/agent.svelte.ts` with class `Agent` — the channel-neutral
  orchestrator. Moved out of `VoiceAgent` verbatim where possible: prompt
  assembly (`#buildPrompt`/`#assembleToolDeclarations`), tool dispatch
  (`#handleToolCall`), the **entire surface-sync engine** (sync + proactive,
  settle/coalesce/markDelivered), `userActionBus` wiring, transcript handling
  (`#onTextOut`/`#onTextIn`/`#onTurnComplete`), status + thinking-watchdog,
  debug (`rec`). Neutral types `AgentSurface`/`AgentMode`/`AgentStatus`/
  `AgentOptions` live here; `SurfaceWatchMode`/`SurfaceWatchTuning` moved as-is.
- `src/lib/voice/agent.svelte.ts` is now `class VoiceAgent extends Agent` — only
  `recording`/`muted` `$state`, `toggleMute()`, `#recorder`/`#player`, and the
  four override hooks. It re-exports `VoiceMode`/`VoiceStatus`/`VoiceAgentSurface`/
  `SurfaceWatchTuning` as back-compat aliases, so `voice/index.ts` and
  `VoiceShell` are untouched.
- `debug.svelte.ts` moved to `src/lib/agent/debug.svelte.ts`; `voice/debug.svelte.ts`
  is now a re-export shim. Class name kept as `VoiceDebugStats` (back-compat) with
  an `AgentDebugStats` alias for the neutral layer; `recordUsage` now takes
  `AgentUsage`.
- `agent/index.ts` exports `Agent` + neutral types + the debug surface
  (`a2ui-svelte/agent` is now a real consumable; the `./agent` export already
  existed from WP1).
- Tests split: channel-neutral cases (tool dispatch, surface-sync sync/proactive,
  userAction, watchdog, debug, **history routing**, **non-streaming profile**)
  moved to `src/lib/agent/agent.test.ts` against a neutral `MockAgentTransport`;
  voice-only cases (mute, audio-out playback + barge-in gate, interrupted, voice
  passthrough) stay in `voice/agent.test.ts`. 125 tests green; `pnpm check` clean;
  `pnpm package`/`publint` all good.

**Capability gating implemented (no `instanceof` anywhere):**
- `#syncTick`/`#syncDataModel` only apply the `modelTurnActive`/`thinking`
  barge-in gate when `capabilities.interruptible`; a non-interruptible transport
  delivers freely.
- `#startSurfaceWatch` starts the poll timer only when `capabilities.streaming`;
  a request/response transport relies on the pre-turn flush (`#syncDataModel` in
  `sendTextMessage`/`#handleUserAction`).
- `'proactive'` mode downgrades to `'sync'` (with a `console.warn`) in the
  constructor when `!capabilities.canInitiateTurn`.
- History routing: `#buildPrompt` includes the history block only for
  `historyOwnership === 'server'`; for `'client'` it omits it and `start()` seeds
  prior turns via the connect `history` option.

**Decisions / deviations from the WP text:**
- **Prompt-builder not yet moved (that's WP3).** The neutral `Agent` imports
  `buildSystemPrompt`/`PromptInputs` from `../voice/prompt-builder` with a `// WP3
  relocates` comment — a temporary `agent → voice` import. WP3 should move the
  file and flip this import to `./prompt-builder`. Functionally inert (pure
  module), just a layering wart until then.
- **History omission via empty array, not a builder flag.** WP2 passes
  `transcriptHistory: []` for client-history transports so it doesn't depend on
  WP3's `includeHistory` work; the block is empty ⇒ `buildSystemPrompt` drops it.
- **WP7 extension points are comments, not dead methods.** Left
  `// WP7 extension point:` markers at `#handleToolCall` (onBeforeToolCall) and
  `#onTurnComplete` (onTurnComplete) rather than unused protected stubs.

**Gotchas for downstream WPs:**
- **Subclass-visible surface = the `protected` members of `Agent`:** `transport`,
  `capabilities`, `modelTurnActive`, `canAppendToUser`, `setStatus`,
  `onModelActivity`, `rec`, `recordInboundAudio`, `pushUnsub`, and the four hooks
  `startInput`/`stopInput`/`wireExtraTransportEvents`/`augmentConnectOptions`. A
  text transport (WP4) needs **none** of them — `new Agent({...})` works directly
  (no-op input hooks), as the neutral test suite proves.
- **`augmentConnectOptions` is how a subclass widens connect opts.** `VoiceAgent`
  overrides it to add `voice` and narrows the return type to
  `VoiceTransportConnectOptions` (covariant override) to dodge the excess-property
  check. WP4's text transport doesn't need it.
- **The `MockAgentTransport` in `agent/agent.test.ts`** advertises a voice-profile
  `capabilities` and uses `text-out` (not `audio-out`) to mark "model generating".
  It's the template for WP6's scripted/neutral tiers.

### WP3 — DONE (2026-06-07, branch `feat/transport-neutral-agent-wp1`)

- Moved `prompt-builder.ts` → `src/lib/agent/prompt-builder.ts` (`../core` import
  depth unchanged). `src/lib/voice/prompt-builder.ts` is now a `export *` shim;
  `voice/index.ts` re-exports through it untouched. `agent/index.ts` now exports
  the builder + `PromptSurface`. `agent.svelte.ts` import flipped to
  `./prompt-builder` (WP2's temporary `agent→voice` wart removed).
- `PromptInputs.transcriptHistory` is now optional and a new `includeHistory?:
  boolean` force-omits the block (`includeHistory:false` ⇒ no history even when
  supplied). `buildSystemPrompt` computes the effective history; `historyBlock`
  output is byte-identical when history is included. WP2's empty-array routing in
  `#buildPrompt` still works and was left as-is (history *policy* is WP2's).
- `prompt-builder.test.ts` moved alongside; +3 tests for the optional-history
  paths. 128 tests green.

### WP4 — DONE (2026-06-07, branch `feat/transport-neutral-agent-wp1`)

Re-scoped before any code: the first text transport is **Gemini text**
(`GeminiTextTransport`, reusing `@google/genai`), not Anthropic — Anthropic moved
to WP8. New `agent/scripted-transport.ts` + `agent/gemini/` (+ `./agent/gemini`
export); 4 + 6 unit tests, 1 env-gated live test. 138 pass / 1 skip.

**Gotchas / lessons (read before WP6 + WP8):**
- **Gemini request/response function calls have no stable `id`.** Verified against
  `@google/genai@1.52.0` — `FunctionCall.id` is optional and unset in practice
  (only Gemini *Live* populates it). `GeminiTextTransport` synthesises
  `${name}-${turn}-${i}`, keeps a per-turn id→call map, and matches
  `functionResponse` by **name**. WP8 differs: Anthropic's `tool_use.id` is always
  present → echo it straight through, no synthesis.
- **Tool-shape passthrough holds for Gemini, not Anthropic.** Our universal
  `{name,description,parameters}` drops verbatim into Gemini `functionDeclarations`
  (zero remap, same as the voice transport). WP8 must remap to
  `{name,description,input_schema}`.
- **`streaming:false` ≠ no token streaming.** The flag means "no live bidi
  session"; output text still arrives as `text-out` deltas. Capability gates are
  about the session model, not the wire — don't conflate.
- **Mock the SDK client as a `class`, not `vi.fn().mockImplementation(() => …)`.**
  An arrow impl isn't `new`-able (`"… is not a constructor"`). Use
  `GoogleGenAI: class { models = { generateContentStream } }` with a `vi.hoisted`
  stub. The same trap awaits WP8's `@anthropic-ai/sdk` mock.
- **Don't `structuredClone` request params in a test** to snapshot call args —
  `config.abortSignal` (an `AbortSignal`) isn't cloneable and throws. Snapshot
  only the JSON-able fields (`contents` / `tools` / `systemInstruction`).
- **ScriptedTransport: a non-matching turn must NOT consume a reaction.** The
  pre-turn surface-sync rides `sendText` on a no-silent-channel transport, so a
  forwarded `SURFACE_UPDATED` turn reaches the transport interleaved with real
  user turns; it emits a bare `turn-complete` and leaves the queue intact, else a
  scripted multi-turn conversation desyncs. WP6 behaviour scripts rely on this.
- **Live tier:** `A2UI_LIVE_GEMINI=1 GEMINI_API_KEY=… pnpm test transport.live`
  (optional `A2UI_LIVE_GEMINI_MODEL` overrides the `gemini-3.5-flash` default);
  skipped by default so CI stays hermetic.

### WP5 — DONE (2026-06-07, branch `feat/transport-neutral-agent-wp1`)

**What landed:**
- New `src/lib/agent/AgentShell.svelte` — the text/chat shell: props
  `{ agent: Agent }` + `headless`, a default transcript list + textarea + send
  form, a status badge, and a controls row (reset + debug toggle). Snippet slots
  `messages` / `input` / `status` / `controls` mirror `<VoiceShell>`'s API, and
  `debug` (`true` | snippet) binds the token panel to `agent.debug`. No mic, no
  audio. Exported from `agent/index.ts` (the `./agent` export already exists).
- **Extracted the debug box into a shared `src/lib/agent/DebugBox.svelte`**
  (props `{ debug, title?, onClose? }`) and rewired **both** shells to it.
  `<VoiceShell>` now renders `<DebugBox title="Voice token debug" …>` instead of
  its ~70-line inline `{#snippet debugBox}` + ~110 lines of `.a2ui-debug-*` CSS
  (all moved into `DebugBox.svelte`). `<VoiceShell>`'s **public API is unchanged**
  — the `debug` prop, the `customDebug` snippet path, and the toggle all behave
  identically; only internals moved. `DebugBox` is also exported from
  `agent/index.ts` for hosts who want it standalone.
- `AgentShell.test.ts`: mounts the shell against a real `Agent` +
  `ScriptedTransport`, types a message, submits, and asserts both the user turn
  and the scripted model reply render and the input clears; plus `headless` and
  empty-state placeholder cases. 141 pass / 1 skip.
- README gained a **Text agents** section (Agent + `GeminiTextTransport` +
  `<AgentShell>` quick start) and a Concepts bullet for the neutral `Agent`.

**Decisions / deviations from the WP text:**
- **Shell lives in `agent/`, not `voice/`.** §2.1 floated `voice/AgentShell.svelte`
  as an option, but the WP5 Changes section says `agent/AgentShell.svelte` and
  that's the correct layer — a text shell has no business in the voice module. It
  imports only from `./agent.svelte` + `./debug.svelte` + `./DebugBox.svelte`.
- **Lazy session start.** A text shell has no mic-toggle affordance, so the send
  handler auto-`start()`s the agent on the first message when `!agent.connected`,
  then `sendTextMessage`s. The user just types and sends.
- **Did the optional shared-headless refactor, scoped to the debug box only.**
  Extracting `DebugBox` was the high-value de-duplication (it was the single
  biggest copy-paste between the two shells). The transcript list + input form are
  small and the two shells frame them differently (fixed bottom bar vs. inline
  column), so sharing those would have churned `<VoiceShell>` for little gain —
  left as-is.

**Gotchas for downstream WPs:**
- **A text agent uses `Agent` directly** — `new Agent({…})` with a text transport,
  no subclass needed (the WP2 hooks are all no-ops in the base). `<AgentShell>` is
  typed against the base `Agent`, so it also accepts a `VoiceAgent` if a host ever
  wants a mic-less chat view of a voice agent.
- **`DebugBox` is the canonical debug renderer now.** Any future shell (or a host
  rolling its own) should reuse `<DebugBox debug={agent.debug} />` rather than
  re-inline the grid; the `title`/`onClose` props cover the variations.

### WP9 — DONE (2026-06-10, branch `feat/transport-neutral-agent-wp1`)

**What landed** (design + breaking-change table in §0.5; layout in §2.1):
- `Agent` absorbed `VoiceAgent`: `recording`/`muted` state, `toggleMute()`,
  and the recorder/player lifecycle moved in, created iff
  `capabilities.input`/`output` include `'audio'`. The WP2 subclass hooks
  (`startInput`/`stopInput`/`wireExtraTransportEvents`/`augmentConnectOptions`)
  and `pushUnsub` were deleted — the extension axis is the transport, not
  Agent subclassing. `transport`/`capabilities` getters are now **public** (the
  shell reads them). Constructor is `new Agent(definition, transport)`;
  `systemInstruction`→`instructions`, `contextInstructions` optional,
  `mintToken` gone (a connect failure now also sets `configIssue`).
- `AgentTransport` absorbed `VoiceTransport`: optional `sendAudioChunk?`,
  `audio-out` + `interrupted` in the shared event map (wired unconditionally
  by the Agent — they simply never fire on text transports). Connect options
  carry only `systemInstruction`/`tools`/`history?`.
- `GeminiTransport` → **`GeminiLiveTransport`** at
  `agent/gemini/live-transport.ts`; constructor takes
  `{ token, model?, apiVersion?, voice? }` where `token` may be a function
  minted per `connect()`. The deprecated `transcript-in`/`transcript-out`
  dual-emits were removed. `GeminiTextTransport` takes
  `{ apiKey?, model?, baseUrl? }` and rejects `connect()` when it has neither
  an `apiKey` nor a proxy `baseUrl`.
- `<AgentShell>` replaced `VoiceShell`+`ChatShell`: ChatShell's bar/peek/panel
  layout + VoiceShell's mic/mute cluster, rendered iff
  `agent.capabilities.input` includes `'audio'`. Snippet slots: `messages`,
  `input`, `mic`, `status`, `controls`, `debug`, plus `headless`. Typing
  lazy-starts the session on every transport (voice live-APIs accept text
  turns); the mic button is the explicit session control on audio transports.
- `src/lib/voice/` deleted; `./voice` + `./voice/gemini` exports removed;
  `AudioRecorder`/`AudioPlayer`/`debug.test` moved under `agent/`;
  `AgentDebugStats` is the class's real name (no `Voice*` aliases anywhere).
- Example app: one `AgentDefinition` + `buildTransport(choice)` + one
  `<AgentShell {agent} debug />`; the old discriminated-union shell switch and
  the `'proxied-server-side'` mintToken hack are gone.

**Gotchas for WP6/WP8 (and future sessions):**
- **`AudioPlayer` constructs `new AudioContext()` eagerly**, so any test whose
  transport advertises `'audio'` in `output` must mock `./audio-player` (and
  `./audio-recorder` for input) — jsdom has neither. The neutral
  `MockAgentTransport` in `agent/agent.test.ts` therefore advertises
  **text-only modalities** while keeping the streaming/interruptible/server
  flags; the audio paths are covered by the `MockAudioTransport` suite in the
  same file.
- **A transport that advertises audio input but omits `sendAudioChunk`** gets a
  console.warn and no recorder — the agent treats it as a transport bug, not a
  crash.
- The old stray-NUL-byte warning about `voice/agent.svelte.ts` is moot — that
  file no longer exists; `agent/agent.svelte.ts` greps fine.
