# Extensions and v0.8 compliance

The JSON `a2ui-svelte` emits and accepts conforms to the A2UI v0.8
schemas on its default wire — so a spec-compliant external system can
render to and receive events from an `a2ui-svelte` app (you supply the
A2A transport; see
[What `a2ui-svelte` is](a2ui-compatibility.md)). A small number of extra
behaviours that **predate** the spec (and are useful in practice) ship
behind a single per-surface flag and emit their data inside a
namespaced envelope so spec-strict consumers can safely ignore them.

This guide is the index of what's part of v0.8, what's an extension,
how to opt in or out, and how to read the wire.

## The boundary

Two namespaces sit at the boundary:

- **Spec.** Top-level fields of every message conform to the A2UI v0.8
  schemas. The 16 standard catalog components, the four server→client
  message kinds (`surfaceUpdate`, `beginRendering`, `dataModelUpdate`,
  `deleteSurface`), the two client→server events (`userAction`,
  `error`), and the spec-canonical generic tools (`click_button`,
  `update_text_field`) are all spec-pure.
- **Extension.** Library-specific data rides under
  `extensions: { 'a2ui-svelte': { ... } }`. A 3P consumer that doesn't
  recognise the `a2ui-svelte` namespace drops it; the spec result is
  unaffected.

```ts
import { A2UI_EXTENSION_NAMESPACE, wrapExtension, readExtension }
  from 'a2ui-svelte/core';
// 'a2ui-svelte'
```

## The three extension flags

Per-surface `ExtensionOptions` — set on each `<StaticSurface>` /
`<DynamicSurface>` via `options={...}`, on the host root via
`setContext(A2UI_EXTENSIONS_CONTEXT_KEY, …)`, or left at the
`ALL_EXTRAS` default.

| Flag                | Default | What it changes vs. spec-strict                                                                                                                                                                                       |
|---------------------|---------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `surfaceWatch`      | `true`  | The `VoiceAgent` keeps the agent aware of user-driven changes to this surface. Delivery is governed by `surfaceWatchTuning.mode`: a silent, idle-timed A2UI v0.9 data-model delta (`'sync'`, default) or a proactive `<event>SURFACE_UPDATED</event>` text turn (`'proactive'`) — payload wrapped in `extensions['a2ui-svelte']` either way. Off → the agent is never told this surface changed. See the [voice-integration guide](voice-integration.md#surface-change-delivery-surfacewatchtuning). |
| `batchTools`        | `true`  | The surface registers batched siblings `click_buttons({clicks})` and `update_text_fields({updates})` alongside the spec-canonical singulars. Off → only the singulars.                                                  |
| `toolResultExtras`  | `true`  | Tool results carry `updatedSurface`, `updatedContext`, `availableElementIds` under `extensions['a2ui-svelte']`. Off → results are exactly `{ results: [...] }`.                                                          |

Presets: `ALL_EXTRAS` (all on, default) and `STRICT` (all off).
Both are exported from `a2ui-svelte/core`.

## When to flip flags off

- You're integrating with a 3P agent that speaks only spec v0.8. Set
  `STRICT` on the host root.
- You're auditing wire conformance. Run your test surface as
  `options={STRICT}` and assert no `extensions['a2ui-svelte']` leakage.
- You're shipping a surface where the cooldown-suppressed polling would
  be wrong (e.g. an external system mutates the surface mid-turn).
  Flip `surfaceWatch: false` on that surface only.

## `userAction` transport

Pre-v0.8 the library wrapped every `userAction` in an XML-tagged text
turn (`<event>USER_ACTION</event>...`). This is still the only way to
push events into Gemini Live (no native event channel).

v0.8 transports — A2A `DataPart` carriers — implement
`VoiceTransport.sendUserAction?(action)` directly. `VoiceAgent` prefers
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

See [voice-integration.md § A2A](voice-integration.md) for the full
contract.
