# Authoring components

This guide explains how to author A2UI components in Svelte 5 with
`a2ui-svelte`. The `defineA2uiComponent` helper handles the
boilerplate; this document walks through *why* it exists, *what* it
gives you, and *how* to use the field-by-field contract.

## Why `defineA2uiComponent`

Without the helper, every catalog component repeats the same wiring:

- Look up the surface context (`getSurfaceContext()`).
- Look up the parent id (`getParentId()`) — for nesting.
- Generate or accept an `id`.
- Build the A2UI ComponentDefinition shape.
- Register synchronously in setup so parents see the child.
- Re-register inside a `$effect` when reactive deps change.
- Register actions with the action registry.
- Register data sources.
- Tear down on `onDestroy`.
- Strip BoundValue envelopes for the template.
- Detect whether the component is rendering inside an
  `<A2UIRepresentation>` to suppress visible markup.

That's ~30 lines of duplicated infrastructure per file. The helper
collapses it to one declarative call.

## The contract

```ts
defineA2uiComponent({
  type,           // string — A2UI spec component-type name (PascalCase)
  id?,            // string — stable id; auto-generated if omitted
  a2ui,           // () => Record<string, unknown> — inner ComponentDefinition props
  data?,          // { key, value: () => current } — surface data binding
  action?,        // { type: 'click' | 'update', handler }
  isContainer?    // true for Card/Column/Row/List/Tabs
})
// returns: { componentId, dataAttr, isHidden, resolved, fire }
```

### `type`

Pascal-case spec component name. Must match a key in the consumer's
catalog if the component is to be rendered on a dynamic surface.

### `id`

Optional. When omitted the helper mints `${type.toLowerCase()}-${n}`
inside the surface. Stable IDs are recommended for anything the agent
will reference by name. Component IDs use hyphens — never mix
`save-btn` with `save_btn`.

### `a2ui`

A reactive thunk returning the **inner** ComponentDefinition properties
— *not* wrapped in `{ Type: {...} }`. The helper adds the wrapper.

```ts
a2ui: () => ({
  text: { literalString: text },
  usageHint
})
```

The thunk is called once at setup and again inside a `$effect`, so
reactive reads inside it cause re-registration. BoundValue envelopes
(`{ literalString }`, `{ literalNumber }`, `{ literalBoolean }`,
`{ path }`) are intentional — they're how the agent distinguishes
literals from data-model bindings.

The thunk receives the resolved **`componentId`** (the explicit `id` or the
auto-generated one; `undefined` only when rendered outside a surface). Use it
to path-bind a value-bearing input to its own data-model key even when no
explicit `fieldName`/`id` was given — keeping the value out of the structural
snapshot so voice `'sync'`-mode delivery stays on the cheap delta path:

```ts
a2ui: (componentId) => {
  const bindingKey = fieldName ?? componentId;
  return {
    // path-bind the value; literal only as a no-surface fallback
    text: bindingKey ? { path: `/${bindingKey}` } : { literalString: value }
  };
}
```

### `data`

Optional. `{ key, value: () => current }` registers a key in the
surface's data model with a reactive accessor. The agent reads it via
JSON-Pointer paths (`/{key}`) — on dynamic surfaces and (for voice
`'sync'`-mode delivery) as the unit synced to the model.

`key` is **optional**: when omitted it defaults to the component's resolved
`id`. So a value-bearing input should register its value **unconditionally** —
`data: { key: fieldName, value: () => value }` keys by `fieldName` when present
and by the component id otherwise. Pair it with the `bindingKey` path above so
the path and the data-model key always match. (This is exactly what the
built-in `TextField` / `Checkbox` / `Slider` / `DateTimeInput` /
`MultipleChoice` do.)

### `action`

Optional. `'click'` actions take no value. `'update'` actions receive
the new value as a string (the agent's `update_text_field` tool sends
strings). Inside the handler, parse to your real type:

```ts
action: { type: 'update', handler: (v) => { value = Number(v); } }
```

### `isContainer`

Set to `true` for `Card`, `Column`, `Row`, `List`, `Tabs`. The helper
sets parent context so descendants register under this component's id.

## What you get back

```ts
{
  componentId: string | undefined,
  dataAttr:    Record<string, string>,  // { 'data-a2ui-id': componentId }
  isHidden:    boolean,                 // true inside <A2UIRepresentation>
  resolved:    P,                       // a2ui() output with envelopes stripped
  fire:        (value?: string) => Promise<unknown>
}
```

The standard pattern is:

```svelte
<script lang="ts">
  // ... defineA2uiComponent ...
  const handle = defineA2uiComponent({...});
  export const dataAttr = handle.dataAttr;
  export const fire = handle.fire;
  export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
  <p {...handle.dataAttr}>{handle.resolved.text}</p>
{/if}
```

The three `export const`s expose the handle to the composite-component
pattern (see [composite-components.md](composite-components.md)) via
`bind:this`.

## Spec compliance

The helper guarantees:

- The JSON shape the agent sees is exactly `{ [type]: a2ui() }`.
- Container children attach to the right parent (no positional drift).
- The synchronous initial register + reactive re-register sequence
  prevents both the "parent doesn't see me" race and the "agent gets
  stale JSON" race.
- BoundValue envelopes are passed through as-is (the agent needs them);
  `resolved` strips them for the template (templates need raw values).

If you find yourself writing a Svelte template that produces JSON the
spec doesn't allow, **restructure the template** rather than fixing the
JSON post-hoc. The framework can produce 100%-compliant trees from
natural Svelte composition; if your draft doesn't, that's a design
smell.

## Worked example: a `<RatingStars>` component

See the [`build-custom-component`](../../src/lib/skills/build-custom-component.md)
skill for a complete walkthrough including the JSON shape and the
catalog registration. Or read `Button.svelte` and `TextField.svelte` in
the source — those are the canonical real-world references.
