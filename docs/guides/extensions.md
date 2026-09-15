# Extensions and v0.8 compliance

The JSON `a2ui-svelte` emits and accepts conforms to the A2UI v0.8
schemas on its default wire — so a spec-compliant external system can
render to and receive events from an `a2ui-svelte` app (you supply the
A2A model; see
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
| `toolResultSurfaceEcho` | `'delta'` | How much of the post-action surface the `Agent` echoes onto a tool result under `extensions['a2ui-svelte']`. `'delta'` (default) → **only the components that changed**, as a `surfaceDelta` (see [Delta tool results](#delta-tool-results-toolresultsurfaceecho-delta)). `'full'` → the unconditional snapshot: `updatedSurface`, `updatedContext`, `availableElementIds`. `'none'` → results are exactly `{ results: [...] }`. `'changed'` is a deprecated alias for `'delta'`. |
| `pointerTool`           | `true`   | Registers `point_to_elements({element_ids})` — a non-spec tool that makes components glow and scrolls them into view so the agent can *point at* on-screen data without changing it. Off → the tool is not offered (components still glow as a side effect of the agent editing them). See [On-demand pointing](#on-demand-pointing-point_to_elements). |

Presets: `ALL_EXTRAS` (every extension on, default) and `STRICT` (all off).
Both are exported from `a2ui-svelte/core`. `toolResultSurfaceEcho` is the one
extension that isn't a boolean, so "on" means its best setting, `'delta'` —
`'full'` is an explicit opt-in.

## Setting them

```svelte
<!-- src/routes/+layout.svelte — once, at startup -->
<script lang="ts">
  import { configureExtensions } from 'a2ui-svelte/core';
  configureExtensions({ pointerTool: false }); // or configureExtensions(STRICT)
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
- You want the unconditional post-action snapshot on every tool result
  (more tokens, nothing the delta leaves out):
  `toolResultSurfaceEcho: 'full'` (below).

## Delta tool results (`toolResultSurfaceEcho: 'delta'`)

This is the **default**. The alternative is `'full'`, where every
`click_button` / `update_text_field` result carries the whole serialized tree.
That costs more tokens than anything else the library does: each result adds
tens of KB (thousands of tokens), the text stays in the conversation context
for the rest of the session, and on a request/response model it is paid for
again on every following request. The `evals/` context-cost measurement puts a
7-call task on a 6-row todo list at ~169k billed input tokens with the full
echo and pretty-printed JSON, vs ~55k with `'delta'` plus
`compactSurfaceJson`.

With `'delta'` the model stays just as current and the result carries only
what changed. The envelope is still `{ results, extensions: { 'a2ui-svelte': … } }`, but the
extras now report what the action **changed** relative to the model's
last-known state (the system prompt at connect, or the previous tool result):

The unit is one **component**, not one surface: the serialized surface is a flat
`components: [{ id, component }]` list, so two snapshots compare entry by entry.

```jsonc
// a value edit that also recomputed an on-screen total — a few hundred bytes.
// Only the surface that moved is listed, and only the components that moved.
{ "results": [ ... ],
  "extensions": { "a2ui-svelte": { "surfaceDelta": {
    "surfaces": [ {
      "surfaceId": "planning",
      "changed": [ { "id": "plan-foot-total-kitchen",
                     "component": { "Text": { "text": { "literalString": "44h 00m" } } } } ],
      "dataModel": { "shift-ana-2026-09-16": "09:00-21:00" }
    } ],
    "structural": false
  } } } }

// a row disappeared, and a second surface unmounted
{ "results": [ ... ],
  "extensions": { "a2ui-svelte": { "surfaceDelta": {
    "surfaces": [ { "surfaceId": "planning", "removed": [ "plan-row-ana" ] } ],
    "removedSurfaces": [ "sidebar" ],
    "structural": true
  } } } }

// a route change replaced the whole tree — a delta would cost more than
// the tree it describes, so the tree goes instead
{ "results": [ ... ],
  "extensions": { "a2ui-svelte": { "surfaceDelta": {
    "surfaces": [ { "surfaceId": "menu", "full": true, "surface": { ... } } ],
    "structural": true
  } } } }

// nothing changed beyond the spec result
{ "results": [ ... ] }
```

How the model applies it, per surface: replace each component in `changed` by
its `id` (an unfamiliar id is a new component), drop every id in `removed`,
upsert the `dataModel` entries. A surface it is not told about is unchanged.
That is A2UI's own `surfaceUpdate` semantic — upsert by id, never clear the
rest — so only `removed` needs the namespace to exist at all.

A surface entry carries `full: true` when its delta would cost at least
`FULL_RESYNC_RATIO` (0.6) of the surface's own serialized size, or when the
reader has never seen that surface. `surface` then replaces everything known
about that id.

`updatedContext` and `availableElementIds` likewise appear only when they
changed. The prompt-builder reads the mode from the app-wide record and
teaches the model the delta contract instead of the full-echo one.

The delta reports changes the agent did not make, not just its own write: a
click can reset a form or recompute a total, and this is the only way it learns
that without a full echo.

Spec posture is unchanged: everything rides under `extensions['a2ui-svelte']`;
the `results` field is byte-identical across `'full'`,
`'delta'` and `'none'`.

### The `'changed'` alias

`'changed'` was this mode's name while it fell back to the whole tree on any
structural change. It is a real per-component delta now, and `changed` already
names one array inside the payload, so the mode is `'delta'` — the same word
the payload field (`surfaceDelta`) and the watch event (`kind: 'surfaceDelta'`)
already use.
`configureExtensions` normalises the old spelling, so an app that still passes
`'changed'` keeps working. The alias lives on `ExtensionsInput` (what
`configureExtensions` accepts), not on `Extensions` itself, so
`getExtensions().toolResultSurfaceEcho` is always one of `'none' | 'full' |
'delta'` and can be switched on exhaustively.

### Who builds the echo

The **`Agent`** does, not the surface. The tools themselves return exactly
`{ results }`; the agent adds the echo on the way to the model, from the
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

## `userAction` model

Pre-v0.8 the library wrapped every `userAction` in an XML-tagged text
turn (`<event>USER_ACTION</event>...`). This is still the only way to
push events into Gemini Live (no native event channel).

v0.8 models — A2A `DataPart` carriers — implement
`AgentModel.sendUserAction?(action)` directly. The `Agent` prefers
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
the `a2uiClientCapabilities` blob A2A models must put on every
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
