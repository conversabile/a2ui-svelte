# Composite components

A **composite** component is a Svelte component that:

- Renders bespoke HTML / styling / interaction patterns to the user.
- Presents itself to the agent as a clean tree of standard A2UI catalog
  components.

The library ships `<A2UIRepresentation>` as the boundary marker for
this pattern. This guide explains the semantics, the bind-this idiom,
and three worked examples.

## Why composites exist

Sometimes the visual you want — a combobox, a star rating, a custom
file picker — doesn't map cleanly to the standard catalog. You have
two options:

1. **Author a brand-new spec component.** See
   [authoring-components.md](authoring-components.md) and the
   [build-custom-component](../../src/lib/skills/build-custom-component.md)
   skill. Use this when the new component should also be renderable
   dynamically by the agent on `<DynamicSurface>`.

2. **Wrap a small tree of standard components in a composite.** Use
   this when the component is *user-driven* and the agent's
   interaction needs are already covered by `TextField`, `Button`,
   `Checkbox`, etc.

Composites are the right answer when the chrome matters more than the
behaviour: dropdowns, rating widgets, autocomplete inputs, drag-and-drop
zones backed by hidden form fields.

## The `<A2UIRepresentation>` boundary

```svelte
<script lang="ts">
  import { A2UIRepresentation } from 'a2ui-svelte/authoring';
  import { TextField, Button } from 'a2ui-svelte/components';

  let inputNode = $state<TextField>();
  let saveNode  = $state<Button>();
  let value = $state('');
</script>

<A2UIRepresentation>
  <Column>
    <TextField bind:this={inputNode} id="input" fieldName="value" bind:value />
    <Button bind:this={saveNode} id="save" primary label="Save" action={{ name: 'save' }} />
  </Column>
</A2UIRepresentation>

<div class="my-bespoke-look">
  <input bind:value {...inputNode?.dataAttr} />
  <button {...saveNode?.dataAttr} onclick={() => saveNode?.fire()}>Save</button>
</div>
```

Semantics:

- **Inside `<A2UIRepresentation>`**: catalog components register with
  the surface registry but render nothing to the DOM.
  `defineA2uiComponent`'s `isHidden` flag is set; templates honour it
  with `{#if !handle.isHidden}`.
- **Outside `<A2UIRepresentation>`**: write whatever HTML you want.
  Use `bind:this` to capture each catalog node's `dataAttr` (for
  highlight targeting) and `fire()` (to share the same action handler
  with the agent).

This is one explicit boundary instead of per-element `headless` props.
The IDE flags missing required props on `<TextField>` and `<Button>`
exactly the same way it does outside the boundary, so the agent-facing
contract is type-checked.

## The bind-this idiom

Every catalog component exports three values from its instance:

```ts
export const dataAttr;      // Record<string, string>
export const fire;          // (value?: string) => Promise<unknown>
export const componentId;   // string | undefined
```

Capture them via `bind:this`:

```svelte
let saveNode = $state<Button>();
<Button bind:this={saveNode} id="save" ... />
```

The handle becomes available after mount. Always use the optional-chain
form (`saveNode?.fire()`) — Svelte's `bind:this` is `undefined` on the
first render.

## Worked examples

### 1. SaveTextField

A text field with a bespoke save button next to it. The agent sees a
plain `Column → [TextField, Button]`; the user sees a single styled
input-with-button row.

```svelte
<script lang="ts">
  import { A2UIRepresentation } from 'a2ui-svelte/authoring';
  import { Column, TextField, Button } from 'a2ui-svelte/components';

  interface Props { id?: string; label?: string; onSave?: (v: string) => void; }
  let { id, label = 'Value', onSave }: Props = $props();

  let value = $state('');
  let inputNode = $state<TextField>();
  let saveNode  = $state<Button>();
</script>

<A2UIRepresentation>
  <Column>
    <TextField bind:this={inputNode} id="input" fieldName="value"
               {label} bind:value textFieldType="shortText" />
    <Button bind:this={saveNode} id="save" primary label="Save"
            action={{ name: 'save' }} onclick={() => onSave?.(value)} />
  </Column>
</A2UIRepresentation>

<div class="save-textfield" {id}>
  <label>{label}</label>
  <div class="row">
    <input type="text" bind:value {...inputNode?.dataAttr} />
    <button class="save" {...saveNode?.dataAttr}
            onclick={() => saveNode?.fire()}>Save</button>
  </div>
</div>
```

Both paths converge: user click → bespoke `<button>` → `saveNode.fire()`
→ action handler. Agent click → `click_button("save")` → action handler.

### 2. AutocompleteField (in-tree exemplar)

Look at `src/lib/components/AutocompleteField.svelte` in the library
source. It declares one `TextField` inside `<A2UIRepresentation>`,
then renders a full ARIA combobox underneath with grouped options, a
sticky footer, and keyboard navigation.

The agent only ever sees the `TextField`; everything else is bespoke.
That's the canonical composite pattern.

### 3. RatingPicker → MultipleChoice

A 1–5 star rating widget. The agent sees a `MultipleChoice` with five
options; the user sees five clickable star icons.

```svelte
<script lang="ts">
  import { A2UIRepresentation } from 'a2ui-svelte/authoring';

  // Hypothetical MultipleChoice from your catalog (or a custom one).
  import { MultipleChoice } from '$lib/catalog';

  interface Props { id?: string; value?: number; onchange?: (v: number) => void; }
  let { id, value = $bindable(0), onchange }: Props = $props();

  let mcNode = $state<MultipleChoice>();
  const options = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} stars` }));
</script>

<A2UIRepresentation>
  <MultipleChoice bind:this={mcNode} id="rating" fieldName="rating"
                  {options} bind:value />
</A2UIRepresentation>

<div class="rating-picker" {id} {...mcNode?.dataAttr}>
  {#each [1, 2, 3, 4, 5] as n}
    <button class:filled={n <= value}
            onclick={() => { value = n; mcNode?.fire(String(n)); onchange?.(n); }}
    >★</button>
  {/each}
</div>
```

The agent will pick a rating via the `MultipleChoice`'s update action
(`update_text_field("rating", "4")`); the user clicks a star directly;
both end at `value = 4`.

## Pitfalls

- **Forgetting `?.`** on `bind:this` handles. They're undefined on the
  first render — always use `node?.dataAttr` and `node?.fire()`.
- **Duplicating IDs.** The `id` you pass *inside* the representation is
  what the agent uses. Don't reuse the same string for the bespoke
  HTML `id` attribute unless you mean to.
- **Hiding catalog components manually.** Don't add `{#if false}` or
  `display: none`. Use `<A2UIRepresentation>` — it's the only sanctioned
  way to suppress visible markup while keeping registration.
