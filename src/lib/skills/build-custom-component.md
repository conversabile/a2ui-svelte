---
name: build-custom-component
description: Use when adding a new component type to the A2UI catalog — a spec-shaped component the agent can render dynamically and the user sees natively.
type: skill
---

# Build a custom A2UI component

## When to use this skill

Use this skill when the default catalog (`Text`, `Button`, `Card`,
`Column`, `Row`, `List`, `Tabs`, `TextField`, `Checkbox`, …) doesn't
cover what you need and you want to ship a **new component type** —
something the agent can spawn on a dynamic surface or compose
declaratively in your code, with JSON output that conforms to the A2UI
v0.8 spec.

If you only need bespoke HTML/styling but the agent should still see one
of the existing types, use `build-composite-component` instead.

Trigger phrases: "new A2UI component", "add a custom catalog entry",
"extend the catalog", "register a custom component type".

## How to apply

### 1. Pick a spec-aligned `type` name

The `type` is what the agent emits in `surfaceUpdate.components[].component`
and what the renderer looks up in the catalog. Use PascalCase
(`RatingStars`, `Slider`). If your component is meant to be a brand-new
spec component, follow the spec's naming conventions.

### 2. Write the Svelte file with `defineA2uiComponent`

The helper handles registration, reactive re-registration, BoundValue
unwrapping (`{ literalString: 'x' }` → `'x'`), data sources, action
registration, and `onDestroy` cleanup.

```svelte
<!-- src/lib/components/RatingStars.svelte -->
<script lang="ts">
  import { defineA2uiComponent } from 'a2ui-svelte/authoring';

  interface Props {
    id?: string;
    value?: number;        // 0..max
    max?: number;          // default 5
    fieldName?: string;
    onchange?: (v: number) => void;
  }

  let { id, value = $bindable(0), max = 5, fieldName, onchange }: Props = $props();

  const handle = defineA2uiComponent<{
    value: { literalNumber: number };
    max: { literalNumber: number };
    fieldName?: string;
  }>({
    type: 'RatingStars',
    id,
    a2ui: () => ({
      value: { literalNumber: value },
      max: { literalNumber: max },
      ...(fieldName ? { fieldName } : {})
    }),
    data: fieldName ? { key: fieldName, value: () => value } : undefined,
    action: {
      type: 'update',
      handler: (v: string) => {
        value = Number(v);
        onchange?.(value);
      }
    }
  });

  export const dataAttr = handle.dataAttr;
  export const fire = handle.fire;
  export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
  <div {...dataAttr} class="rating-stars" role="radiogroup" aria-label="Rating">
    {#each Array(max) as _, i}
      <button
        type="button"
        class:filled={i < value}
        aria-label="{i + 1} of {max} stars"
        onclick={() => handle.fire(String(i + 1))}
      >★</button>
    {/each}
  </div>
{/if}
```

### 3. Match the spec contract for the JSON shape

Every property in the `a2ui()` thunk's return becomes part of the JSON
the agent sees. Wrap literal values with the BoundValue envelope
(`{ literalString }`, `{ literalNumber }`, `{ literalBoolean }`, or
`{ path }`) so the agent can substitute reactive bindings:

```json
{
  "RatingStars": {
    "value": { "literalNumber": 3 },
    "max":   { "literalNumber": 5 },
    "fieldName": "rating"
  }
}
```

### 4. Register with the consumer's catalog

The default catalog is closed; consumers extend it with their custom
types using `extendCatalog`:

```ts
// src/lib/catalog.ts (consumer side)
import { DEFAULT_CATALOG, extendCatalog } from 'a2ui-svelte/authoring';
import RatingStars from './components/RatingStars.svelte';

export const catalog = extendCatalog(DEFAULT_CATALOG, { RatingStars });
```

Then pass it to `<DynamicSurface catalog={catalog}>` (or use
`setCatalog(catalog)` in a layout `+layout.svelte` setup block to scope
it for an entire route subtree).

### 5. Expose `dataAttr`, `fire`, `componentId`

Always re-export the three properties from the handle. They're what the
composite-component pattern (and tests) use to reach into your component
from outside.

### 6. Verify the JSON via `SurfaceRegistry.toJSON()`

Drop the component into a `<StaticSurface>` and call `surfaceRef.toJSON()`.
The output should validate against the spec — exactly one type wrapper,
no Svelte-only fields leaking through, BoundValue envelopes intact.

A quick spot-check in the browser console:

```js
const json = document.querySelector('[data-a2ui-surface]')?.__surface?.toJSON();
console.log(JSON.stringify(json, null, 2));
```

## Common variations

- **Container component.** Pass `isContainer: true` so children register
  under your component's id. Then in the template, render `{@render children()}`
  where you want them to appear.
- **No interactivity.** Omit the `action` field — `Text`, `Image`-style
  display-only components don't need an action.
- **Server-driven options.** Use `data: { key, value: () => current }` to
  publish a reactive value into the surface data model so the agent can
  bind UI elsewhere via `path` references.

## Related skills

- `build-a2ui-page` — assembling pages from the catalog.
- `build-composite-component` — when bespoke HTML is the goal.
- `style-and-theme` — restyling without forking.
