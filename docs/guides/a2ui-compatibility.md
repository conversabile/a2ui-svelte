# What `a2ui-svelte` is (and what A2UI compatibility means)

New to A2UI? Read this once and you'll know exactly what this library
does for you — and where you'll have to do the work yourself.

## A2UI in one line

[A2UI](https://a2ui.org/) is a protocol for an **AI agent to
generate user interfaces**: the agent sends UI as JSON (a tree of
standard components), the client renders it, and user interactions flow
back as events. `a2ui-svelte` implements the A2UI v0.8 component
catalog, messages, and events in Svelte 5.

## Two surface patterns — only one is classic A2UI

| | `<StaticSurface>` | `<DynamicSurface>` |
|---|---|---|
| **Who builds the UI** | You, in Svelte | The agent, at runtime |
| **Is it A2UI?** | No — our own inversion | Yes — the literal A2UI model |
| **Status** | **Primary, stable path** | **Experimental — can be slow / unreliable** |

**`<StaticSurface>` is not classic A2UI, and that's the point.** A2UI
assumes the agent owns the UI. Most real apps don't want that — they
already own their UI in a framework. So we inverted it: you lay out the
UI in Svelte, and `a2ui-svelte` makes that UI *legible and drivable* by
an agent using the same A2UI components, IDs, and generic tools
(`click_button`, `update_text_field`). This is the case we support best.

**`<DynamicSurface>` is real A2UI** — an empty canvas the agent fills in
via `surfaceUpdate` / `beginRendering`. It works, but agent-generated UI
is currently slow and error-prone; treat it as experimental.

## How the agent connects

Today there is **one end-to-end agent path that ships working**: the
built-in voice layer (`a2ui-svelte/voice` + Gemini), where
`a2ui-svelte` owns the agent and drives surfaces through LLM function
tools. Everything in the Quick Start uses this path.

### Connecting a 3rd-party agent is a gap you fill

The A2UI spec's network transport is **A2A** (a server→client stream of
`DataPart`s, plus a client→server event channel). `a2ui-svelte` ships
the *contract*, not a working connection:

- ✅ Message/event types (`A2UIServerMessage`, `A2UIClientEvent`).
- ✅ Envelope helpers `wrapA2A` / `unwrapA2A` (`application/json+a2ui`
  `DataPart`, `X-A2A-Extensions` header constants).
- ✅ The `<A2ASurface>` adapter that wires a transport to the renderer.
- ❌ **No concrete SSE / WebSocket transport.** You implement the
  `A2ATransport` interface yourself (`connect`, `onMessage`,
  `sendEvent`, `close`).

So an external A2UI agent *can* render to and receive events from an
`a2ui-svelte` app — once you've written the ~one-file transport that
carries the bytes. See the
[A2A section of the voice guide](voice-integration.md#a2a-network-integration-mode).

## What conforms to the v0.8 wire

Within the bounds above, the JSON `a2ui-svelte` emits and accepts is
spec-conformant:

- **All 16 standard catalog components** with their spec-defined props
  (Text, Image, Icon, Divider, Button, TextField, CheckBox, Slider,
  DateTimeInput, MultipleChoice, Row, Column, List, Card, Modal, Tabs).
- **All four server→client messages** — `surfaceUpdate`,
  `beginRendering`, `dataModelUpdate`, `deleteSurface`.
- **Both client→server events** — `userAction` (spec-mandated
  `{ name, surfaceId, sourceComponentId, timestamp, context }` shape)
  and `error`.
- **Spec-canonical generic tools** — `click_button({element_id})` and
  `update_text_field({element_id, value})`.
- **Catalog-selection handshake** — capabilities under
  `a2uiClientCapabilities`, standard-catalog URI default.
- **A2A envelope** — `DataPart` + `X-A2A-Extensions` header.

Library-specific extras (surface-change polling, batched tools, richer
tool-result envelope, an on-demand `point_to_elements` highlight tool,
XML-tagged `userAction` for voice live-APIs) ride under a namespaced
`extensions: { 'a2ui-svelte': … }` envelope and can be turned off per
surface. See the [extensions guide](extensions.md).

## Coming from the official renderers (`web_core`)?

`a2ui-svelte` re-implements the A2UI v0.8 core in idiomatic Svelte rather than
wrapping `@a2ui/web_core` — the shared core behind the official Angular, React
and Lit renderers. It accepts the same wire JSON, but a few **runtime
behaviours differ**. If you're used to the official renderers, expect these on
a `<DynamicSurface>`:

- **Data-bound lists aren't rendered yet.** Containers resolve
  `children.explicitList` / `child` only. A `children.template`
  (`dataBinding` + `componentId`) that repeats a component over a data-model
  array currently renders **nothing**, and there's no per-item data context for
  relative paths. Static trees render identically — data-driven repetition is
  the gap.
- **No `Video` or `AudioPlayer`.** The default catalog ships 16 of the 18
  standard component types; the two media components aren't included.
- **Best-effort, not strict.** `web_core` validates every message against a
  schema and throws on malformed input. `a2ui-svelte` renders what it can and
  logs warnings, so bad agent output degrades quietly instead of erroring.

These differences only affect `<DynamicSurface>`.