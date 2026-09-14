# Implementation Plan — Rename `AgentTransport` to `AgentModel`

**Status:** done — WP1–WP9 all landed in one changeset; `pnpm check`,
`pnpm test`, `pnpm eval:hermetic`, `pnpm package` and
`pnpm --filter minimal-app build` all green.
**Delivery:** one commit. The work packages below are ordered stages with a
check at each boundary, not separate commits.
**Scope:** terminology only. No behaviour change, no contract change, no new or
removed capability. Every rename is 1:1.
**Breaking:** yes — public type and class names in `a2ui-svelte/agent` and every
`a2ui-svelte/agent/<provider>` subpath (CLAUDE.md Rule 8).
**Related:** [model-neutral-agent-framework.md](model-neutral-agent-framework.md)
(the plan that introduced the name), [CLAUDE.md](../../CLAUDE.md) Rule 6.

---

## 0. Why

`AgentTransport` names the per-provider adapter, but the thing it names is not a
channel:

- it chooses the model (the model ID is a constructor argument);
- it holds the credential ([model.ts:53](../../src/lib/agent/model.ts#L53)
  — "Auth belongs to the transport, not the agent", as it read before this
  plan);
- it owns conversation history when `historyOwnership: 'client'`;
- it **runs the agentic tool loop** for every text provider, decides when a turn
  is complete, and suppresses provider signals that fire mid-loop.

"Transport" is specific networking vocabulary for a channel that passively
carries bytes. This decides turn boundaries and does the reasoning.

The name is a leftover: when the library was voice-only, `GeminiLiveTransport`
wrapped a WebSocket session and the word was roughly honest. The
transport-neutral refactor generalised the abstraction and kept the name.

**The collision that settles it.** The repo already uses "transport" for a real
transport — [src/lib/transport/a2a.ts](../../src/lib/transport/a2a.ts) and the
`./transport` export are A2A message envelopes over a wire, with no reasoning.
Two unrelated concepts share the word, and the smaller one deserves it.

**Why `AgentModel` and not `Model`.** A2UI has a per-surface *data model*
([client-data-model.ts](../../src/lib/core/client-data-model.ts); v0.9
data-model sync). Bare `ModelCapabilities` reads ambiguously in this codebase.
The `Agent` prefix disambiguates.

**Accepted imprecision.** `AnthropicTextModel` is a class that can run Opus or
Haiku, so strictly it is a *connection to* a model, not a model. The accurate
names (`…ModelConnection`, `…ModelSession`) cost length on every line for a
distinction nobody will misread. `agent.model` reads correctly; take the
imprecision.

---

## 1. The rename table

Decided. Nothing else in `src/lib/agent/` keeps the word "transport".

| old | new |
|---|---|
| `AgentTransport` | `AgentModel` |
| `TransportCapabilities` | `AgentModelCapabilities` |
| `AgentTransportConnectOptions` | `AgentModelConnectOptions` |
| `AgentTransportEventMap` | `AgentModelEventMap` |
| `GeminiLiveTransport` | `GeminiLiveModel` |
| `GeminiTextTransport` | `GeminiTextModel` |
| `AnthropicTextTransport` | `AnthropicTextModel` |
| `OpenAITextTransport` | `OpenAITextModel` |
| `OpenAIRealtimeTransport` | `OpenAIRealtimeModel` |
| `DeepgramVoiceAgentTransport` | `DeepgramVoiceAgentModel` |
| `HumeEviTransport` | `HumeEviModel` |
| `ScriptedTransport` | `ScriptedModel` |
| `…TransportOptions` (7 of them) | `…ModelOptions` |
| `forwardTransport` / `ForwardedTransport` | `forwardModel` / `ForwardedModel` |
| `Agent#transport`, `agent.transport` | `Agent#model`, `agent.model` |
| `new Agent(definition, transport)` | `new Agent(definition, model)` |

**Unchanged:** `src/lib/transport/`, the `./transport` export, `A2ATransport`,
`A2ATransportOptions`, `<A2ASurface>`. That layer is a transport.
`TransportCapabilities`' own fields (`streaming`, `interruptible`,
`silentContext`, `historyOwnership`, `canInitiateTurn`, `input`, `output`) are
unchanged, as are all event names and method names.

**File renames** (plain `mv` — CLAUDE.md forbids me touching git; git detects
the renames by content similarity when you commit, so history follows anyway):

| old | new |
|---|---|
| `src/lib/agent/transport.ts` | `src/lib/agent/model.ts` |
| `src/lib/agent/scripted-transport.ts` | `src/lib/agent/scripted-model.ts` |
| `src/lib/agent/forward-transport.ts` | `src/lib/agent/forward-model.ts` |
| `src/lib/agent/<provider>/*-transport.ts` | `…/*-model.ts` (7 files) |
| the 9 matching `*.test.ts` | same |
| `docs/guides/transport-providers.md` | `docs/guides/model-providers.md` |
| `docs/implementation_plans/transport-neutral-agent-framework.md` | `…/model-neutral-agent-framework.md` |

**No deprecated aliases.** The package is pre-1.0 and experimental; a parallel
set of `@deprecated` type aliases would double the name surface for the exact
audience that does not exist yet. Clean break, `feat(agent)!:`, CHANGELOG note.

---

## 2. Cost, and where it actually is

1164 occurrences of "transport", 1104 of them under
[src/lib/agent/](../../src/lib/agent/). The split matters:

- **Identifiers — mechanical.** Ordered `sed` (longest name first, `\b`
  boundaries) over the table above. Safe, verified by `pnpm check`.
- **Prose — manual.** Comments and docs use the lowercase word in sentences
  where the right replacement varies: "model" (`the transport decides`),
  "model adapter" (`transport implementations`), "provider"
  (`per-transport auth`), "connection" (`the transport is open`). A blind sed
  produces wrong sentences. This is the real work and it is per-file.

Doc mention counts, for sizing: the plan doc 203, [agent-integration.md](../guides/agent-integration.md)
105, [testing-and-evals-v3.md](testing-and-evals-v3.md) 62, [README.md](../../README.md)
43, [CLAUDE.md](../../CLAUDE.md) 39, [integrate-agent.md](../../src/lib/skills/integrate-agent.md)
39, [model-providers.md](../guides/model-providers.md) 17, plus 9 smaller files.

---

## 3. Work packages

One commit at the end, so the order is chosen for cheap verification rather than
for green intermediate commits.

**WP1 — every file rename and every identifier, in one pass.** `mv` the 18 source
files and 2 docs, then an ordered `sed` (longest name first, `\b` boundaries)
over the whole tree for the §1 table plus the test-only fakes: `MockAgentTransport`
(36 mentions), `FakeTransport`, `FullFakeTransport`, `MockAudioTransport`,
`MockTransport`, `EchoTestTransport`, `AudioCapableTransport`,
`RecordingTransport`, `makeEvalTransport`, `buildTransport`,
`wireCommonTransportEvents`, `wireExtraTransportEvents`. Exclude
[src/lib/transport/](../../src/lib/transport/), `evals/results/`,
`docs/implementation_plans/archived/`, and this file.

Doing identifiers globally in one step is only possible because there is no
intermediate commit to keep green — and it is the safer order: the tree is either
consistent or `pnpm check` says exactly where it isn't.

**Gate:** `pnpm check && pnpm test`. Everything after this point is prose, so
this gate is the one that proves the rename is correct.

**WP2 — prose, library.** The lowercase word in comments, in dependency order so
the vocabulary is settled before it spreads: [model.ts](../../src/lib/agent/model.ts)
(the contract's doc comments define the vocabulary), then
[agent.svelte.ts](../../src/lib/agent/agent.svelte.ts) (~100),
[AgentShell.svelte](../../src/lib/agent/AgentShell.svelte),
[prompt-builder.ts](../../src/lib/agent/prompt-builder.ts),
[debug.svelte.ts](../../src/lib/agent/debug.svelte.ts), the 7 provider adapters,
scripted + forward.

**WP3 — prose, tests and evals.** The 9 renamed spec files,
[agent.test.ts](../../src/lib/agent/agent.test.ts) (258 mentions),
[AgentShell.test.ts](../../src/lib/agent/AgentShell.test.ts),
[agent.echo.test.ts](../../src/lib/agent/agent.echo.test.ts),
[A2ASurface.test.ts](../../src/lib/renderer/A2ASurface.test.ts) (careful — A2A
names stay), [evals/setup.ts](../../evals/setup.ts),
[llm-scenarios.eval.ts](../../evals/llm-scenarios.eval.ts),
[context-cost.eval.ts](../../evals/context-cost.eval.ts),
[evals/README.md](../../evals/README.md).

**Gate:** `pnpm test && pnpm eval:hermetic`.

**WP4 — example app.** `pnpm package`, then the 8 files under
[examples/minimal-app/](../../examples/minimal-app/).

**Gate:** `pnpm --filter minimal-app build` — the only check that catches
Node-only code reaching the browser bundle.

**WP5 — skills.** [integrate-agent.md](../../src/lib/skills/integrate-agent.md)
(39), [test-a2ui-app.md](../../src/lib/skills/test-a2ui-app.md) (11),
[build-a2ui-page.md](../../src/lib/skills/build-a2ui-page.md) (1). CLAUDE.md
requires skills stay in sync with the code.

**WP6 — docs.** [README.md](../../README.md), [agent-integration.md](../guides/agent-integration.md),
`transport-providers.md` → `model-providers.md`, [testing.md](../guides/testing.md),
[evals.md](../guides/evals.md), [extensions.md](../guides/extensions.md),
[a2ui-compatibility.md](../guides/a2ui-compatibility.md), plus the doc map and
key-file table in CLAUDE.md.

**WP7 — CLAUDE.md Rule 6.** "Transport Neutrality" → **"Model Neutrality"**, and
the rule states its real intent: *never branch on the model's identity*. Two
edits need thought, not sed:
- the rule's own body still calls new channels "new **transports** (or transport
  wrappers, e.g. STT/TTS around a text model)" — an STT/TTS composite is three
  services behind one `AgentModel`; say that;
- the "deliberately gone" list (`VoiceAgent`, `VoiceTransport`, `VoiceShell`,
  `ChatShell`) is a historical record of removed class names. Keep the names
  verbatim, reword the sentence around them.

**WP8 — the plan doc.** `mv transport-neutral-agent-framework.md
model-neutral-agent-framework.md`; update §0.5 and the contract sections to the
new vocabulary; add a one-line header note that the plan was written when the
abstraction was called `AgentTransport`. **Do not rewrite its work-package log** —
that is a record of what was done under the old name. Same for
`docs/implementation_plans/archived/` (4 files, 39 mentions): leave them.

**WP9 — set this plan's status to done** and repoint the file links in it, which
are written against the pre-`mv` paths.

---

## 4. Verification

`pnpm check`, `pnpm test`, `pnpm package` (publint sees the exports map),
`pnpm --filter minimal-app build`. Then
`grep -rn "ransport" src/lib/agent evals examples src/lib/skills` must return
**zero** hits — the only surviving "transport" in the repo is
[src/lib/transport/](../../src/lib/transport/), the A2A surfaces that consume it,
the four archived plans, `evals/results/`, and this file.

`pnpm eval` is not a gate (needs `GEMINI_API_KEY`, costs money);
`pnpm eval:hermetic` in WP3 exercises the same wiring offline.

**Proposed commit message** (one commit, breaking — `standard-version` reads the
`!`):

```
refactor(agent)!: rename AgentTransport to AgentModel

The per-provider adapter chooses the model, holds the credential, owns
conversation history, and runs the agentic tool loop — it is not a channel
that passively carries bytes. "Transport" was a leftover from the voice-only
era, and it collided with src/lib/transport/, the A2A message layer that
really is a transport.

1:1 rename, no behaviour change. Capability fields, event names and method
names are unchanged. src/lib/transport/ and A2ATransport keep the word.

BREAKING CHANGE: AgentTransport is now AgentModel, TransportCapabilities is
AgentModelCapabilities, AgentTransportConnectOptions is
AgentModelConnectOptions, AgentTransportEventMap is AgentModelEventMap, and
the eight transport classes (GeminiLive, GeminiText, AnthropicText,
OpenAIText, OpenAIRealtime, DeepgramVoiceAgent, HumeEvi, Scripted) end in
Model rather than Transport, along with their options types.
forwardTransport/ForwardedTransport are forwardModel/ForwardedModel, and
agent.transport is agent.model. No deprecated aliases ship.
```

---

## 5. What landed

All nine work packages, one changeset. Gates run: `pnpm check` (0 errors),
`pnpm test` (342 passed), `pnpm eval:hermetic`, `pnpm package` (publint clean),
`pnpm --filter minimal-app build`.

Three decisions taken during the work that §1–§3 did not cover:

- **`A2UI_EVAL_TRANSPORT` → `A2UI_EVAL_MODEL_FAMILY`** (and `EVAL_TRANSPORT` →
  `EVAL_MODEL_FAMILY`). The knob picks text vs live, and `A2UI_EVAL_MODEL`
  already names the model id, so "model family" is the accurate name. This
  changes an eval env-var contract, not the public API.
- **`model-neutral-agent-framework.md` is only partly renamed.** The title, a
  new naming note in the header, §0.5's prose and §3's pointer to
  `src/lib/agent/model.ts` use today's names. The WP9 migration table, §1–§4 and
  the §8 log keep `AgentTransport`/`VoiceTransport`/`GeminiTransport` verbatim —
  they record what was built under the old name.
- **`A2ASurface.svelte` / `A2ASurface.test.ts` untouched**, like
  `src/lib/transport/`: every "transport" in them is the A2A one.

The only "transport" left in tracked, non-archived files: `src/lib/transport/`,
the A2A surfaces and the A2A sections of the guides, `evals/vitest.config.ts`
(`ws`'s node transport), one `CHANGELOG.md` entry, and this plan.
