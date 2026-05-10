---
name: build-composite-component
description: Use when the user wants bespoke HTML/styling for a component but the agent should still see a clean tree of standard A2UI catalog components (the AutocompleteField pattern).
type: skill
---

# Build a composite A2UI component

## When to use this skill

Use this skill when:

1. You need a custom Svelte component with **non-standard markup** —
   custom form widgets, popovers, charts, interactive cards.
2. But the agent should still see it as a **standard A2UI component**
   (or small tree of them) so `click_button(id)` and
   `update_text_field(id, value)` keep working.

The canonical exemplar in the library is `AutocompleteField.svelte`: the
agent sees a plain `TextField`; the user sees a combobox with grouped
options and a sticky footer.

If you need a brand-new spec-shaped component (with its own catalog
entry the agent can render dynamically), use `build-custom-component`
instead.

Trigger phrases: "custom widget", "bespoke HTML", "the agent should see
it as a TextField but the user sees X", "AutocompleteField pattern",
"two-faced component".

## How to apply

### 1. Wrap the agent-facing structure in `<A2UIRepresentation>`

`<A2UIRepresentation>` is a context-only wrapper. Catalog components
inside it **register with the surface registry** (so the agent sees
them) but **render no visible markup**.

```svelte
<script lang="ts">
  import { A2UIRepresentation } from 'a2ui-svelte/authoring';
  import { Column, TextField, Button } from 'a2ui-svelte/components';

  interface Props { id?: string; label?: string; placeholder?: string; }
  let { id, label = 'Value', placeholder = '' }: Props = $props();

  let value = $state('');

  // Capture handles via bind:this — exposed by every catalog component.
  let inputNode  = $state<TextField>();
  let saveNode   = $state<Button>();

  function commit() { /* persist value somewhere */ }
</script>

<A2UIRepresentation>
  <Column>
    <TextField bind:this={inputNode} id="input" fieldName="value"
               {label} bind:value textFieldType="shortText" />
    <Button bind:this={saveNode} id="save" primary label="Save"
            action={{ name: 'save' }} onclick={commit} />
  </Column>
</A2UIRepresentation>

<!-- Now render whatever HTML you actually want the user to see. -->
<div class="my-bespoke-look" {id}>
  {#if label}<label>{label}</label>{/if}
  <input
    type="text"
    {placeholder}
    bind:value
    {...inputNode?.dataAttr}
  />
  <button class="my-save-btn" {...saveNode?.dataAttr}
          onclick={() => saveNode?.fire()}>
    Save
  </button>
</div>
```

### 2. Capture each catalog node with `bind:this`

Every catalog component exposes:

- `componentId` — the resolved id (from `id` prop or auto-generated).
- `dataAttr` — `{ 'data-a2ui-id': componentId }`. Spread it on the user-facing
  element so the highlight + reveal helpers find it.
- `fire(value?)` — programmatically trigger the registered action.

You'll usually need both `dataAttr` (so glow effects target the right
element) and `fire()` (so user clicks route into the same handler the
agent's clicks go through).

### 3. Wire user events to the handles

The bespoke HTML is just chrome. Behaviour lives on the catalog
components. So when the user clicks your bespoke save button, call
`saveNode?.fire()` instead of duplicating the handler logic.

For inputs: `bind:value` already updates Svelte state; the `update`
action handler on `TextField` runs whenever the agent sets a value.
You usually don't need to explicitly call `fire()` for typing — just
keep the same `value` variable bound on both sides.

### 4. Verify both paths

Test:
- **User path:** click your bespoke save button. The action handler fires.
- **Agent path:** in the live session, `click_button("save")`. The same
  handler fires; the bespoke button glows (because `dataAttr` is on it).

If only one path works, the most common cause is mismatched IDs between
`<A2UIRepresentation>` declarations and the component your bind reads.
Component IDs flow from the `id` prop you pass *inside* the
representation, not from the bespoke HTML's `id` attribute.

### 5. Read `AutocompleteField.svelte` as the in-tree exemplar

The library ships `AutocompleteField` as the canonical composite. It
declares a single `TextField` inside `<A2UIRepresentation>`, then
renders a full ARIA combobox underneath. Read the source to see how
display value, dropdown state, and `dataAttr` interact.

## Common variations

- **Multiple bind targets.** Declare more than one catalog component
  inside `<A2UIRepresentation>` and capture each via its own `bind:this`.
  Distribute their `dataAttr` and `fire()` across your bespoke HTML.
- **Container composites.** A composite can declare a `Column` or `List`
  inside the representation, then render its own visible layout that
  reorders or filters the visible items. The agent still sees the
  declared order.
- **Pure-display composite.** A representation containing only `Text`
  nodes (no actions) is fine — useful when you want the agent to read a
  semantic tree but render bespoke typography.

## Related skills

- `build-custom-component` — for net-new spec components.
- `build-a2ui-page` — assembling pages from these.
- `style-and-theme` — token-based restyling without composites.
