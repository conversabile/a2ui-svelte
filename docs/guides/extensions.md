# Extensions and v0.8 compliance

The JSON `a2ui-svelte` emits and accepts conforms to the A2UI v0.8
schemas on its default wire — so a spec-compliant external system can
render to and receive events from an `a2ui-svelte` app (you supply the
A2A transport; see
[What `a2ui-svelte` is](a2ui-compatibility.md)). A small number of extra
behaviours that **predate** the spec (and are useful in practice) ship
behind one app-wide extension record and emit their data inside a
namespaced envelope so spec-strict consumers can safely ignore them.

This guide is the index of what's part of v0.8, what's an extension,
how to opt in or out, and how to read the wire.

## The boundary

Two namespaces sit at the boundary:

- **Spec.** Top-level fields of every message conform to the A2UI v0.8
  schemas. The 16 standard catalog components, the four server→client
  message kinds (`surfaceUpdate`, `beginRendering`, `dataModelUpdate`,
  `deleteSurface`) and the two client→server events (`userAction`,
  `error`) are all spec-pure. The built-in tools (`click_button`,
  `update_text_field`) are **ours** — the spec has no agent-drives-the-UI
  direction — but their results carry nothing beyond `{ results }`, so a
  spec-strict consumer sees no stray fields.
- **Extension.** Library-specific data rides under
  `extensions: { 'a2ui-svelte': { ... } }`. A 3P consumer that doesn't
  recognise the `a2ui-svelte` namespace drops it; the spec result is
  unaffected.

```ts
import { A2UI_EXTENSION_NAMESPACE, wrapExtension, readExtension }
  from 'a2ui-svelte/core';
// 'a2ui-svelte'
```

## The four extensions

`Extensions` is **one app-wide record**, set once at startup — an extension
describes the protocol the library speaks, not a region of the page, and half
of them name a *global* tool, so two surfaces cannot disagree about whether a
tool name exists.

| Extension               | Default  | What it changes vs. spec-strict                                                                                                                                                                                       |
|-------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `surfaceWatch`          | `true`   | The `Agent` keeps the model aware of user-driven surface changes. Delivery is governed by `surfaceWatchTuning.mode`: a silent, idle-timed A2UI v0.9 data-model delta (`'sync'`, default) or a proactive `<event>SURFACE_UPDATED</event>` text turn (`'proactive'`) — payload wrapped in `extensions['a2ui-svelte']` either way. Off → the agent is never told a surface changed. See the [agent-integration guide](agent-integration.md#surface-change-delivery-surfacewatchtuning). |
| `batchTools`            | `true`   | Declares the batched siblings `click_buttons({clicks})` / `update_text_fields({updates})` to the model **instead of** the singular pair. The singulars stay registered either way. Off → the model sees the singulars.                                                  |
| `toolResultSurfaceEcho` | `'full'` | How much of the post-action surface the `Agent` echoes onto a tool result under `extensions['a2ui-svelte']`. `'full'` → `updatedSurface`, `updatedContext`, `availableElementIds`. `'changed'` → **only what changed** (see [Changed-only tool results](#changed-only-tool-results-toolresultsurfaceecho-changed)). `'none'` → results are exactly `{ results: [...] }`.                                                          |
| `pointerTool`           | `true`   | Registers `point_to_elements({element_ids})` — a non-spec tool that makes components glow and scrolls them into view so the agent can *point at* on-screen data without changing it. Off → the tool is not offered (components still glow as a side effect of the agent editing them). See [On-demand pointing](#on-demand-pointing-point_to_elements). |

Presets: `ALL_EXTRAS` (all on, default) and `STRICT` (all off).
Both are exported from `a2ui-svelte/core`.

## Setting them

```svelte
<!-- src/routes/+layout.svelte — once, at startup -->
<script lang="ts">
  import { configureExtensions } from 'a2ui-svelte/core';
  configureExtensions({ toolResultSurfaceEcho: 'changed' }); // or configureExtensions(STRICT)
</script>
```

The partial is merged over `ALL_EXTRAS`, not over the current record: the call
is an absolute set, so `configureExtensions({})` restores the defaults. Read
it back anywhere with `getExtensions()`.

Call it **before any surface mounts** — the record is read when the generic
tools are installed (as the first static surface mounts), so a later call
cannot un-register a live tool. On the server the record is module-level and
shared by every request; that is correct (it describes the app, not the user)
but is one more reason to set it at startup rather than per request.

## When to turn extensions off

- You're integrating with a 3P agent that speaks only spec v0.8:
  `configureExtensions(STRICT)`.
- You're auditing wire conformance: run under `STRICT` and assert no
  `extensions['a2ui-svelte']` leakage.
- Your surface is huge and the full echo dominates the token bill:
  `toolResultSurfaceEcho: 'changed'` (below).

## Changed-only tool results (`toolResultSurfaceEcho: 'changed'`)

The default full echo is the library's single biggest **token amplifier**: on
a dense surface every `click_button` / `update_text_field` result re-ships the
whole serialized tree (tens of KB ≈ thousands of tokens), it stays in the
conversation context forever, and on a request/response transport it is
re-billed on every subsequent loop request. The `evals/` context-cost
measurement puts a 7-call task on a 6-row planner at ~179k billed input tokens
with the full echo vs ~63k with `'changed'`.

`toolResultSurfaceEcho: 'changed'` keeps the model informed while shipping only
deltas. The envelope is still `{ results, extensions: { 'a2ui-svelte': … } }`, but the
extras now report what the action **changed** relative to the model's
last-known state (the system prompt at connect, or the previous tool result):

```jsonc
// a value edit — a few hundred bytes instead of the whole tree
{ "results": [ ... ],
  "extensions": { "a2ui-svelte": {
    "updatedDataModel": { "shift-planner": { "shift-anna-wed": "10:00-18:00" } }
  } } }

// a structural change (a component appeared/disappeared, navigation) —
// the full tree, exactly like 'full' mode, because a delta can't convey it
{ "results": [ ... ],
  "extensions": { "a2ui-svelte": { "updatedSurface": [ ... ] } } }

// nothing changed beyond the spec result
{ "results": [ ... ] }
```

`updatedContext` and `availableElementIds` likewise appear only when they
changed. The prompt-builder reads the mode from the app-wide record and
teaches the model the changed-only contract instead of the full-echo one.

`updatedDataModel` matters even though the model "knows what it wrote": a
click can mutate fields the agent didn't touch (a form resetting after save),
and the delta is the only way it learns that without a full echo.

Spec posture is unchanged: everything rides under `extensions['a2ui-svelte']`;
the `results` field is byte-identical across `'full'`,
`'changed'` and `'none'`.

### Who builds the echo

The **`Agent`** does, not the surface. The tools themselves return exactly
`{ results }`; the agent adds the echo on the way to the transport, from the
surfaces its own `AgentDefinition.surfaces()` declares.

Two consequences worth knowing:

- There is **one** "what the model last saw" snapshot per agent, seeded from
  the system prompt at connect. So a click in surface A and a click in surface
  B diff against the same baseline, and neither re-reports a change the model
  already has.
- An external spec-compliant agent calling `toolRegistry.execute('click_button', …)`
  directly gets `{ results }` with no echo. That is correct under `STRICT`, and
  harmless otherwise — such an agent drops the `a2ui-svelte` namespace anyway.

A tool opts into the echo with `mutatesSurface: true` on its `ToolDefinition`.
The click/update pair and their batched forms set it; `point_to_elements` does
not (see below).

## On-demand pointing (`point_to_elements`)

When the agent edits a component (`click_button` / `update_text_field`) the
client glows the affected element and scrolls it into view — a built-in
acknowledgement of the change. The `pointerTool` extension exposes that same
gesture as a **standalone, non-mutating tool** so the agent can draw the
user's eye to data it *isn't* changing:

```jsonc
point_to_elements({ "element_ids": ["order-total", "save-btn"] })
```

Each ID is revealed (tab-switched if needed), scrolled into view, and glowed,
in order. Use it for "where do I save this?", "show me the total", or to
indicate a value the agent just mentioned out loud.

**Where it fits the spec.** A2UI v0.8 models *structure*, *state*, and
*intent* — it has no concept of an agent pointing at a component, because
highlighting is a pure presentation gesture. So this is genuinely outside the
spec and lives entirely under the `a2ui-svelte` namespace: a non-spec generic
tool, gated by `pointerTool` (off under `STRICT`, so a spec-strict agent never
sees it). The spec-network counterpart would be a server→client extension
message `{ extensions: { 'a2ui-svelte': { kind: 'highlight', surfaceId,
elementIds } } }` carried in an A2A `DataPart`; on the voice path the function
tool is the working vehicle.

**Deliberately lean results.** Unlike `click_button` / `update_text_field`,
`point_to_elements` **never** gets the surface echo — whatever
`toolResultSurfaceEcho` says, because it does not declare `mutatesSurface`. It returns only:

```jsonc
{ "results": [
  { "element_id": "order-total", "status": "success" },
  { "element_id": "typo-id",     "status": "error",
    "error": "No element \"typo-id\" on any mounted surface" }
] }
```

A purely visual "look here" call leaves the agent's surface understanding
unchanged, so echoing the whole (potentially 100 KB+) surface back would be
pure token waste. `status` tells the agent which IDs resolved to a real
on-screen element, so it can avoid claiming it pointed at something that
isn't there — pointing at an id that isn't on screen **is** a failure, so it
reports `error` like every other tool. The status vocabulary is exactly
`success` / `error` for every tool we ship, which is what the system prompt
promises the model.

## `userAction` transport

Pre-v0.8 the library wrapped every `userAction` in an XML-tagged text
turn (`<event>USER_ACTION</event>...`). This is still the only way to
push events into Gemini Live (no native event channel).

v0.8 transports — A2A `DataPart` carriers — implement
`AgentTransport.sendUserAction?(action)` directly. The `Agent` prefers
the typed call when implemented, falls back to the wrapped text turn
otherwise. The emitted `UserAction` is always spec-canonical, including
`context: {}` when the source component declared none.

## Catalog selection

The renderer's catalog registry is keyed by URI per A2UI v0.8 §2.1.3:

- `STANDARD_CATALOG_ID = "https://a2ui.org/specification/v0_8/standard_catalog_definition.json"`
- `'standard'` is accepted as a back-compat alias.
- An absent `surface.catalogId` resolves to the standard catalog by
  the URI fallback chain (URI → alias → `catalog` prop).

Use `getClientCapabilities(catalogs)` from `a2ui-svelte/core` to build
the `a2uiClientCapabilities` blob A2A transports must put on every
outbound message. Use `getAgentCardExtensionParams({ catalogs,
acceptsInlineCatalogs })` when serialising your AgentCard. For v0.9
`sendDataModel`, use `getClientDataModel(surfaceIds)` to build the
`a2uiClientDataModel` blob attached to that same metadata (see the A2A
section below).

## A2A transport (spec-aligned network mode)

`a2ui-svelte/transport` exports `A2ATransport`, the wire-envelope
helpers `wrapA2A` / `unwrapA2A`, the four-message server→client union
type `A2UIServerMessage`, and the two-event client→server union
`A2UIClientEvent`. `wrapA2A` also attaches the v0.9 `a2uiClientDataModel`
metadata (built with `getClientDataModel`) when a surface enabled
`sendDataModel`. Pair them with `<A2ASurface>` from
`a2ui-svelte/renderer` to integrate over the network.

See [agent-integration.md § A2A](agent-integration.md) for the full
contract.
