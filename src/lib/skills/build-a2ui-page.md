---
name: build-a2ui-page
description: Use when adding a new SvelteKit page to an a2ui-svelte app and the AI voice agent should be able to read and interact with it.
type: skill
---

# Build an A2UI page

## When to use this skill

Use this skill when you are adding a new route (page) to a SvelteKit app
that already consumes `a2ui-svelte` and you want the live voice agent to
*see* the page's UI and *act on it* (click buttons, fill text fields,
toggle checkboxes, etc.). The app already has a single `<AgentShell>` /
`Agent` mounted in the root layout — your job is to declare a
**static surface** on this page so the agent picks it up.

Trigger phrases: "add a page", "new route", "make this page agent-aware",
"expose this UI to the voice agent".

## How to apply

### 1. Mount a `<StaticSurface>` at the page root

`StaticSurface` provides the `surfaceId`, an isolated registry, and the
JSON serialiser. Everything declared inside it is part of one A2UI tree.

```svelte
<!-- src/routes/checkout/+page.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { StaticSurface } from 'a2ui-svelte/renderer';
  import { Card, Column, TextField, Button } from 'a2ui-svelte/components';
  import { session } from '$lib/session.svelte'; // app-side store; see step 3

  let name = $state('');
  let email = $state('');

  function placeOrder() { /* ... */ }
</script>

<StaticSurface surfaceId="checkout-form">
  <Card>
    <Column>
      <TextField id="name"  label="Name"  bind:value={name} />
      <TextField id="email" label="Email" bind:value={email} />
      <Button id="place-order" primary label="Place order" onclick={placeOrder} />
    </Column>
  </Card>
</StaticSurface>
```

Rules:
- One `<StaticSurface>` per page region. Multiple are allowed; each must have
  a unique `surfaceId`.
- Use catalog components (`Card`, `Column`, `Button`, …) for *every* visible
  element — the screen-and-tree-parity rule.
- Every interactive component needs an `id`; the agent uses these IDs to
  target elements.

### 2. Compose the page with catalog components

The default catalog covers the A2UI v0.8 standard set: `Text`, `Image`,
`Button`, `TextField`, `Checkbox`, `Card`, `Column`, `Row`, `List`,
`Tabs`. Compose them like normal Svelte components.

Container property contracts (these are spec-mandated, the helpers enforce them):
- `Card` has a single `child` — wrap multiples in a `Column` or `Row`.
- `Column` / `Row` / `List` use `children: { explicitList: [...] }`.
- `Button` has a single `child` (its label) — pass it via `label` prop.

### 3. Publish the page's context

The surface itself needs no publishing: `<StaticSurface>` joins the
library's global index on mount and leaves it on destroy, so the layout's
`surfaces: mountedSurfaces` sees it (see `integrate-agent` skill).

What is still yours to publish is the page's prose context — a thin
reactive store the layout reads:

```ts
// src/lib/session.svelte.ts
function createSession() {
  let contextInstructions = $state('');
  return {
    get contextInstructions() { return contextInstructions; },
    set contextInstructions(v) { contextInstructions = v; }
  };
}
export const session = createSession();
```

Then in your page, write it on mount and clear it on destroy:

```svelte
<script lang="ts">
  // ...continued from step 1
  onMount(() => {
    session.contextInstructions =
      'The checkout page collects name and email then places the order.';
  });
  onDestroy(() => {
    session.contextInstructions = '';
  });
</script>
```

The store name is up to you — pick something that fits your app's naming
conventions.

### 4. Add page-specific `contextInstructions`

`contextInstructions` is a free-form prompt segment the agent receives
alongside the surface JSON. Use it to explain *what the page is for* and
*what success looks like*. Don't use it for facts the agent can already
read off the JSON tree.

Good: "The checkout page collects name and email and places the order."
Bad: "There is a button labelled 'Place order'." (already in the tree)

### 5. Cleanup on destroy

Always reset `session.contextInstructions = ''` in `onDestroy` —
otherwise the agent keeps reading a page's instructions after the user
has navigated away. The surface removes itself from the index on its own.

## Common variations

- **Multi-surface page.** Two independent regions on one page — just mount
  two `<StaticSurface>`s; each needs its own `surfaceId` and both show up in
  `mountedSurfaces()`.
- **List of items the agent might click.** Wrap each item in a
  `<Row>`/`<Column>` containing a `Button` with a stable, slug-based id
  (`id={`item-${item.slug}`}`). The agent will reference items by id, not
  by index.
- **Form with conditional fields.** Use plain `{#if}` blocks. The reactive
  re-registration in `defineA2uiComponent` means showing/hiding a field
  cleanly removes it from the tree.

## Related skills

- `build-custom-component` — when the catalog doesn't have what you need.
- `build-composite-component` — when you need bespoke HTML but the agent
  should still see a clean A2UI tree.
- `integrate-agent` — wiring the layout-level `Agent` + transport.
