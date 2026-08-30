# Component Gallery

Every A2UI component, in the two forms you meet it: the **Svelte** tab is how
you write it in `a2ui-svelte`; the **v0.8** / **v0.9** tabs are the JSON the
agent reads (and the JSON a dynamic surface renders from).

The canonical property list is the [A2UI v0.8 spec](https://a2ui.org/) — when
it and this page disagree, the spec wins.

## Using a component

On a **static surface** you compose components in a Svelte template and the
library serializes the tree for the agent:

```svelte
<script lang="ts">
  import { StaticSurface } from 'a2ui-svelte/renderer';
  import { Card, Column, TextField, Button } from 'a2ui-svelte/components';

  let email = $state('');
</script>

<StaticSurface surfaceId="signup">
  <Card id="signup-card">
    <Column id="signup-fields">
      <TextField id="email-input" label="Email" bind:value={email} />
      <Button id="signup-btn" primary label="Sign up"
              action={{ name: 'signup-btn' }} onclick={signUp} />
    </Column>
  </Card>
</StaticSurface>
```

On a **dynamic surface** the agent sends the JSON instead and the renderer
builds it from the catalog. Same components, same ids, same catalog.

Reading the tabs:

- A prop that also appears in the **v0.8** tab *is* the spec property, written
  as a plain Svelte value: `text="Hello"` instead of
  `{ "literalString": "Hello" }`, `usageHint="h1"` instead of `"usageHint": "h1"`.
- **Extra Svelte props** are library-side: DOM wiring (`bind:`, `onchange`,
  `class`) or authoring sugar (`fieldName`, Button's `label`). Where such a prop
  changes the emitted JSON, the component's section says how.
- `children`, `child`, `entryPointChild`, `tabItems` are never written by hand —
  the surface derives them from what your template actually rendered.

The default catalog (`DEFAULT_CATALOG`) covers exactly the 16 standard types
below. `AutocompleteField` is exported from `a2ui-svelte/components` but is a
composite, not a catalog entry — see [Extensions](#extensions--authoring-only-composite-components).
To make a custom component renderable on a dynamic surface, register it:
`extendCatalog(DEFAULT_CATALOG, { MyType: MyComponent })`.

---

## Layout Components

### Row

Horizontal layout container. Children are arranged left-to-right.

=== "Svelte"

    ```svelte
    <Row id="toolbar" distribution="spaceBetween" alignment="center">
      <Button id="btn-back" label="Back" action={{ name: 'btn-back' }} onclick={back} />
      <Button id="btn-next" label="Next" action={{ name: 'btn-next' }} onclick={next} />
    </Row>
    ```

    Children come from the Svelte template — the surface builds
    `children.explicitList` from whatever actually rendered.

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `children` (`explicitList` or `template`), `distribution`, `alignment`

    ```json
    {
      "id": "toolbar",
      "component": {
        "Row": {
          "children": { "explicitList": ["btn1", "btn2", "btn3"] },
          "distribution": "spaceBetween",
          "alignment": "center"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `children` (array or template), `justify`, `align`

    ```json
    {
      "id": "toolbar",
      "component": "Row",
      "children": ["btn1", "btn2", "btn3"],
      "justify": "spaceBetween",
      "align": "center"
    }
    ```

### Column

Vertical layout container. Children are arranged top-to-bottom.

=== "Svelte"

    ```svelte
    <Column id="content" distribution="start" alignment="stretch">
      <Text id="content-title" text="Today" usageHint="h2" />
      <Text id="content-body" text="Two slots left." />
    </Column>
    ```

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `children` (`explicitList` or `template`), `distribution`, `alignment`

    ```json
    {
      "id": "content",
      "component": {
        "Column": {
          "children": { "explicitList": ["header", "body", "footer"] },
          "distribution": "start",
          "alignment": "stretch"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `children` (array or template), `justify`, `align`

    ```json
    {
      "id": "content",
      "component": "Column",
      "children": ["header", "body", "footer"],
      "justify": "start",
      "align": "stretch"
    }
    ```

### List

Scrollable list of items. Supports static children and dynamic templates.

=== "Svelte"

    ```svelte
    <List id="message-list" direction="vertical" alignment="stretch">
      {#each messages as m (m.id)}
        <Text id={`message-${m.id}`} text={m.body} />
      {/each}
    </List>
    ```

    The JSON `template` binding is a dynamic-surface feature; on a static surface
    you iterate with `{#each}` and the tree gets an `explicitList` of the rendered
    rows. Give each row a stable, slug-based id so the agent can name it.

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `children` (`explicitList` or `template`), `direction`, `alignment`

    ```json
    {
      "id": "message-list",
      "component": {
        "List": {
          "children": {
            "template": {
              "dataBinding": "/messages",
              "componentId": "message-item"
            }
          },
          "direction": "vertical"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `children` (array or template), `direction`, `align`

    ```json
    {
      "id": "message-list",
      "component": "List",
      "children": {
        "componentId": "message-item",
        "path": "/messages"
      },
      "direction": "vertical"
    }
    ```

---

## Display Components

### Text

Display text content with styling hints.

=== "Svelte"

    ```svelte
    <Text id="title" text="Welcome to A2UI" usageHint="h1" />
    ```

    `usageHint` picks the tag: `h1`–`h5` → headings, `caption` → `<small>`,
    `body` (default) → `<p>`.

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `text` (BoundValue), `usageHint`

    `usageHint` values: `h1`, `h2`, `h3`, `h4`, `h5`, `caption`, `body`

    ```json
    {
      "id": "title",
      "component": {
        "Text": {
          "text": { "literalString": "Welcome to A2UI" },
          "usageHint": "h1"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `text` (string or DataBinding), `variant`

    `variant` values: `h1`, `h2`, `h3`, `h4`, `h5`, `caption`, `body`

    ```json
    {
      "id": "title",
      "component": "Text",
      "text": "Welcome to A2UI",
      "variant": "h1"
    }
    ```

### Image

Display images from URLs.

=== "Svelte"

    ```svelte
    <Image
      id="hero"
      url="https://example.com/hero.png"
      fit="cover"
      usageHint="hero"
      accessibility={{ label: 'Sunlit terrace' }}
    />
    ```

    `accessibility.label` doubles as the `alt` text.

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `url` (BoundValue), `fit`, `usageHint`

    ```json
    {
      "id": "hero",
      "component": {
        "Image": {
          "url": { "literalString": "https://example.com/hero.png" },
          "fit": "cover",
          "usageHint": "hero"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `url` (string or DataBinding), `fit`, `variant`

    ```json
    {
      "id": "hero",
      "component": "Image",
      "url": "https://example.com/hero.png",
      "fit": "cover",
      "variant": "hero"
    }
    ```

### Icon

Display icons from the standard set defined in the catalog.

=== "Svelte"

    ```svelte
    <Icon id="check-icon" name="check" />
    ```

    `name` must be a key of the built-in Lucide subset (`A2UI_ICONS`, exported
    from `a2ui-svelte/components`); an unknown name renders as its own text so the
    surface stays debuggable.

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `name` (BoundValue)

    ```json
    {
      "id": "check-icon",
      "component": {
        "Icon": {
          "name": { "literalString": "check" }
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `name` (string or DataBinding)

    ```json
    {
      "id": "check-icon",
      "component": "Icon",
      "name": "check"
    }
    ```

### Divider

Visual separator line.

=== "Svelte"

    ```svelte
    <Divider id="separator" axis="horizontal" />
    ```

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `axis`

    ```json
    {
      "id": "separator",
      "component": {
        "Divider": {
          "axis": "horizontal"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `axis`

    ```json
    {
      "id": "separator",
      "component": "Divider",
      "axis": "horizontal"
    }
    ```

---

## Interactive Components

### Button

Clickable button that triggers an action.

=== "Svelte"

    ```svelte
    <Button
      id="submit-btn"
      primary
      label="Submit"
      action={{ name: 'submit-btn' }}
      onclick={submitForm}
    />
    ```

    `label` is authoring sugar for the spec's single `child`: the library registers
    the label as its own `Text` component (`submit-btn-label`) and points `child`
    at it. Keep `action.name` identical to `id` — the agent clicks what it sees.

    **Extra Svelte props:** `label`, `onclick`, `type`, `class`.

=== "v0.8"

    **Properties:** `child` (component ID), `primary` (boolean), `action`

    ```json
    {
      "id": "submit-btn",
      "component": {
        "Button": {
          "child": "submit-text",
          "primary": true,
          "action": {
            "name": "submit_form"
          }
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `child` (component ID), `variant`, `action`

    ```json
    {
      "id": "submit-btn",
      "component": "Button",
      "child": "submit-text",
      "variant": "primary",
      "action": {
        "event": {
          "name": "submit_form"
        }
      }
    }
    ```

### TextField

Text input field with optional validation.

=== "Svelte"

    ```svelte
    <TextField
      id="email-input"
      label="Email Address"
      textFieldType="shortText"
      bind:value={email}
    />
    ```

    You never write the spec's `text` property: the library path-binds it to
    `/email-input` and keeps the value in the surface's data model — see
    [`id` is the data path](#id-is-the-data-path).

    **Extra Svelte props:** `bind:value`, `onchange`, `placeholder`, `disabled`,
    `inline`, `suffix`, `fieldName`, `class`.

=== "v0.8"

    **Properties:** `label` (BoundValue), `text` (BoundValue), `textFieldType`, `validationRegexp`

    `textFieldType` values: `shortText`, `longText`, `number`, `obscured`, `date`

    ```json
    {
      "id": "email-input",
      "component": {
        "TextField": {
          "label": { "literalString": "Email Address" },
          "text": { "path": "/user/email" },
          "textFieldType": "shortText"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `label` (string), `value` (string or DataBinding), `textFieldType`, `validationRegexp`

    `textFieldType` values: `shortText`, `longText`, `number`, `obscured`, `date`

    ```json
    {
      "id": "email-input",
      "component": "TextField",
      "label": "Email Address",
      "value": { "path": "/user/email" },
      "textFieldType": "shortText"
    }
    ```

### CheckBox

Boolean toggle.

=== "Svelte"

    ```svelte
    <Checkbox id="terms-checkbox" label="I agree to the terms" bind:checked={agreed} />
    ```

    The A2UI type is `CheckBox`; the Svelte export is `Checkbox`. `bind:checked`
    drives the spec's `value`, path-bound to `/terms-checkbox`.

    **Extra Svelte props:** `bind:checked`, `onchange`, `disabled`, `fieldName`,
    `class`.

=== "v0.8"

    **Properties:** `label` (BoundValue), `value` (BoundValue, boolean)

    ```json
    {
      "id": "terms-checkbox",
      "component": {
        "CheckBox": {
          "label": { "literalString": "I agree to the terms" },
          "value": { "path": "/form/agreedToTerms" }
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `label` (string), `value` (DataBinding, boolean)

    ```json
    {
      "id": "terms-checkbox",
      "component": "CheckBox",
      "label": "I agree to the terms",
      "value": { "path": "/form/agreedToTerms" }
    }
    ```

### Slider

Numeric range input.

=== "Svelte"

    ```svelte
    <Slider id="volume" label="Volume" minValue={0} maxValue={100} step={5} bind:value={volume} />
    ```

    **Extra Svelte props:** `bind:value`, `step`, `onchange`, `disabled`,
    `fieldName`, `class`, and `label` — the visible caption, which the component
    also emits as a `label` property (v0.8 doesn't list one for `Slider`).

=== "v0.8"

    **Properties:** `value` (BoundValue), `minValue`, `maxValue`

    ```json
    {
      "id": "volume",
      "component": {
        "Slider": {
          "value": { "path": "/settings/volume" },
          "minValue": 0,
          "maxValue": 100
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `value` (DataBinding), `minValue`, `maxValue`

    ```json
    {
      "id": "volume",
      "component": "Slider",
      "value": { "path": "/settings/volume" },
      "minValue": 0,
      "maxValue": 100
    }
    ```

### DateTimeInput

Date and/or time picker.

=== "Svelte"

    ```svelte
    <DateTimeInput
      id="date-picker"
      label="Booking date"
      enableDate
      enableTime={false}
      bind:value={bookingDate}
    />
    ```

    `value` is `YYYY-MM-DD` for date-only, `HH:mm` for time-only, and
    `YYYY-MM-DDTHH:mm` when both are enabled.

    **Extra Svelte props:** `bind:value`, `onchange`, `disabled`, `fieldName`,
    `class`, and `label` (same non-spec `label` property as `Slider`).

=== "v0.8"

    **Properties:** `value` (BoundValue), `enableDate`, `enableTime`

    ```json
    {
      "id": "date-picker",
      "component": {
        "DateTimeInput": {
          "value": { "path": "/booking/date" },
          "enableDate": true,
          "enableTime": false
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `value` (DataBinding), `enableDate`, `enableTime`

    ```json
    {
      "id": "date-picker",
      "component": "DateTimeInput",
      "value": { "path": "/booking/date" },
      "enableDate": true,
      "enableTime": false
    }
    ```

### MultipleChoice (v0.8) / ChoicePicker (v0.9)

Select one or more options from a list.

=== "Svelte"

    ```svelte
    <MultipleChoice
      id="country-select"
      label="Country"
      options={[
        { label: 'USA', value: 'us' },
        { label: 'Canada', value: 'ca' }
      ]}
      maxAllowedSelections={1}
      bind:selections={countries}
    />
    ```

    `maxAllowedSelections={1}` renders radio buttons; anything higher renders
    checkboxes. `selections` is always a `string[]`.

    **Extra Svelte props:** `bind:selections`, `onchange`, `disabled`, `fieldName`,
    `class`, and `label` (same non-spec `label` property as `Slider`).

=== "v0.8"

    **Properties:** `options` (array), `selections` (BoundValue), `maxAllowedSelections`

    ```json
    {
      "id": "country-select",
      "component": {
        "MultipleChoice": {
          "options": [
            { "label": { "literalString": "USA" }, "value": "us" },
            { "label": { "literalString": "Canada" }, "value": "ca" }
          ],
          "selections": { "path": "/form/country" },
          "maxAllowedSelections": 1
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `options` (array), `selections` (DataBinding), `maxAllowedSelections`

    ```json
    {
      "id": "country-select",
      "component": "ChoicePicker",
      "options": [
        { "label": "USA", "value": "us" },
        { "label": "Canada", "value": "ca" }
      ],
      "selections": { "path": "/form/country" },
      "maxAllowedSelections": 1
    }
    ```

---

## Container Components

### Card

Container with elevation/border and padding.

=== "Svelte"

    ```svelte
    <Card id="info-card">
      <Column id="card-content">
        <Text id="card-title" text="Order #1024" usageHint="h3" />
        <Text id="card-body" text="Ships tomorrow." />
      </Column>
    </Card>
    ```

    A Card has a single `child` — wrap several elements in a `Column` or `Row`.

    **Extra Svelte props:** `class`.

=== "v0.8"

    **Properties:** `child` (component ID)

    ```json
    {
      "id": "info-card",
      "component": {
        "Card": {
          "child": "card-content"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `child` (component ID)

    ```json
    {
      "id": "info-card",
      "component": "Card",
      "child": "card-content"
    }
    ```

### Modal

Overlay dialog triggered by an entry point component.

=== "Svelte"

    ```svelte
    <Modal id="confirmation-modal" bind:open={showConfirm}>
      {#snippet entryPoint()}
        <Button id="open-modal-btn" label="Delete" action={{ name: 'open-modal-btn' }}
          onclick={() => (showConfirm = true)} />
      {/snippet}
      {#snippet content()}
        <Column id="modal-content">
          <Text id="modal-text" text="Delete this order?" />
        </Column>
      {/snippet}
    </Modal>
    ```

    The two snippets register as the Modal's first and second children; the
    serializer pairs them with `entryPointChild` / `contentChild`.

    **Extra Svelte props:** `entryPoint` / `content` snippets, `bind:open`, `class`.

=== "v0.8"

    **Properties:** `entryPointChild` (component ID), `contentChild` (component ID)

    ```json
    {
      "id": "confirmation-modal",
      "component": {
        "Modal": {
          "entryPointChild": "open-modal-btn",
          "contentChild": "modal-content"
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `entryPointChild` (component ID), `contentChild` (component ID)

    ```json
    {
      "id": "confirmation-modal",
      "component": "Modal",
      "entryPointChild": "open-modal-btn",
      "contentChild": "modal-content"
    }
    ```

### Tabs

Tabbed interface for organizing content into switchable panels.

=== "Svelte"

    ```svelte
    <Tabs
      id="settings-tabs"
      tabs={[
        { key: 'general', title: 'General' },
        { key: 'privacy', title: 'Privacy' }
      ]}
    >
      {#snippet content(key)}
        {#if key === 'general'}
          <Column id="general-tab"><Text id="general-text" text="General settings" /></Column>
        {:else}
          <Column id="privacy-tab"><Text id="privacy-text" text="Privacy settings" /></Column>
        {/if}
      {/snippet}
    </Tabs>
    ```

    `tabs` is the Svelte-side shape of `tabItems` (`key` picks the panel, `title`
    is the visible label); each panel registers as that tab's `child`. All panels
    render, so the agent can switch tabs with `update_text_field` on the Tabs id,
    passing a title, key, or index.

    **Extra Svelte props:** `tabs`, `content` snippet, `class`.

=== "v0.8"

    **Properties:** `tabItems` (array of `{ title, child }`)

    ```json
    {
      "id": "settings-tabs",
      "component": {
        "Tabs": {
          "tabItems": [
            { "title": { "literalString": "General" }, "child": "general-tab" },
            { "title": { "literalString": "Privacy" }, "child": "privacy-tab" }
          ]
        }
      }
    }
    ```

=== "v0.9"

    **Properties:** `tabItems` (array of `{ title, child }`)

    ```json
    {
      "id": "settings-tabs",
      "component": "Tabs",
      "tabItems": [
        { "title": "General", "child": "general-tab" },
        { "title": "Privacy", "child": "privacy-tab" }
      ]
    }
    ```

---

## Common Properties

Shared by every component, in Svelte and in JSON:

- `id` — unique within the surface. It is what the agent targets, what
  `action.name` must match, and (for value-bearing components) the data-model
  key their value binds to. Omit it and the library mints `text-3`,
  `button-1`, … — fine for decoration, never for anything the agent may act on.
  Use hyphens throughout; mixing `save-button` with `save_button` makes agents
  hallucinate ids.
- `accessibility` — `{ label, role }`, rendered as `aria-label` / `role`.
- `weight` — flex-grow inside a `Row`, `Column`, or `List`.

Every Svelte component also takes `class` — styling only, invisible to the
agent — and containers take their children as ordinary Svelte children.

### `id` is the data path

The value-bearing components (`TextField`, `CheckBox`, `Slider`,
`DateTimeInput`, `MultipleChoice`) don't inline their value in the tree. They
path-bind it into the surface's **data model** under the component `id`:

```svelte
<TextField id="email" label="Email" bind:value={email} />
```

```json
{
  "components": [
    { "id": "email", "component": { "TextField": {
        "label": { "literalString": "Email" },
        "text": { "path": "/email" } } } }
  ],
  "data": { "email": "ada@example.com" }
}
```

The agent reads the value from `data`, and writes it with
`update_text_field({ element_id: "email", value })` — keyed by the `id`, so
every value-bearing component is agent-writable whether or not you bind it.

Pass the optional `fieldName` prop only when **two components edit one value**:
they keep distinct ids (the agent targets each) and share a single data key.

```svelte
<Slider    id="portions-slider" fieldName="portions" bind:value={portions} />
<TextField id="portions-input"  fieldName="portions" bind:value={portions} />
```

## Version Differences Summary

The component names and properties are largely the same across versions. The structural differences are:

| Aspect | v0.8 | v0.9 |
|--------|------|------|
| Component wrapper | `"component": { "Text": { ... } }` | `"component": "Text", ...props` |
| String values | `{ "literalString": "Hello" }` | `"Hello"` |
| Children | `{ "explicitList": ["a", "b"] }` | `["a", "b"]` |
| Data binding | `{ "path": "/data" }` | `{ "path": "/data" }` (same) |
| Text/Image styling | `usageHint` | `variant` |
| Button styling | `primary: true` | `variant: "primary"` |
| Action format | `{ "name": "..." }` | `{ "event": { "name": "..." } }` |
| Choice component | `MultipleChoice` | `ChoicePicker` |
| Layout alignment | `distribution`, `alignment` | `justify`, `align` |
| TextField value | `text` | `value` |

## Live Examples

The example consumer app renders the catalog against a live agent:

```bash
cp examples/minimal-app/.env.template examples/minimal-app/.env  # add a provider key
pnpm --filter minimal-app dev
```

## Further Reading

- **[Authoring components](../guides/authoring-components.md)** — build a
  catalog component of your own with `defineA2uiComponent`.
- **[Composite components](../guides/composite-components.md)** — bespoke HTML
  that still serializes as a standard type.
- **[Theming](../guides/theming.md)** — style the catalog through `--a2ui-*`
  tokens.
- **[A2UI compatibility](../guides/a2ui-compatibility.md)** — what this library
  supports, extends, and doesn't implement.

---

## Extensions — authoring-only composite components

`a2ui-svelte` ships two helpers that are **not** part of the A2UI v0.8
standard catalog and are therefore **deliberately excluded from
`DEFAULT_CATALOG`**. They exist purely for *static-surface authoring* — a
human developer composes them in a Svelte template, and the agent still sees
a 100%-spec-compliant component tree.

| Helper | Exported from | Purpose |
|---|---|---|
| `AutocompleteField` | `a2ui-svelte/components` | A typeahead input. Registers itself to the agent as a standard **`TextField`** while rendering bespoke autocomplete HTML underneath. |
| `A2UIRepresentation` | `a2ui-svelte/authoring` | A wrapper that lets a component declare a different (spec-standard) A2UI representation than the HTML it actually renders — the children inside it register with the surface but render nothing. |

### The composite-pattern contract

A *composite component* renders bespoke HTML for the human user, but to the
agent it MUST appear as one of the 16 standard catalog types. The contract:

1. **Register as a standard type.** Call `defineA2uiComponent({ type: 'TextField' | … })` — never invent a non-standard `type`. The surface JSON the agent receives only ever contains standard component types.
2. **Keep screen/tree parity.** Everything the agent sees in the tree must be visible on screen, and vice-versa. Use `<A2UIRepresentation>` to register the standard sub-tree; its `isHidden` children render nothing themselves so there is no duplicated/hidden DOM.
3. **Route interaction through the standard action.** The agent drives the component with the generic tools (`click_button`, `update_text_field`) targeting the standard type's action — the bespoke HTML is a presentation detail only.
4. **Stay out of `DEFAULT_CATALOG`.** Composites are for static authoring. To make one agent-renderable on a *dynamic* surface, opt in explicitly:

   ```ts
   import { DEFAULT_CATALOG, extendCatalog } from 'a2ui-svelte/authoring';
   import { AutocompleteField } from 'a2ui-svelte/components';
   const MY_CATALOG = extendCatalog(DEFAULT_CATALOG, { AutocompleteField });
   ```

See the [composite-components guide](../guides/composite-components.md) for a
full walk-through.
