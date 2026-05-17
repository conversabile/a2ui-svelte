# Component Gallery

This page showcases all A2UI components with examples and usage patterns.

> The library's default catalog (`DEFAULT_CATALOG`) ships the standard
> catalog set: `Text`, `Image`, `Button`, `TextField`, `Checkbox`,
> `Card`, `Column`, `Row`, `List`, `Tabs`. The library also exports an
> `AutocompleteField` composite under `a2ui-svelte/components`, but it is
> **not** part of the default catalog — it's a composite that registers
> as a `TextField` to the agent. To make it (or any other custom
> component) renderable on a dynamic surface, register it explicitly:
> `extendCatalog(DEFAULT_CATALOG, { MyType: MyComponent })`.

> NOTE: Schema Files
>
> === "v0.8"
>
>     [:material-code-json: Standard Catalog Definition (JSON Schema)](../../specification/v0_8/json/standard_catalog_definition.json)
>
> === "v0.9"
>
>     [:material-code-json: Basic Catalog Definition (JSON Schema)](../../specification/v0_9/json/basic_catalog.json)

---

## Layout Components

### Row

Horizontal layout container. Children are arranged left-to-right.

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

All components share:

- `id` (required): Unique identifier within the surface.
- `accessibility`: Accessibility attributes (label, role).
- `weight`: Flex-grow value when inside a Row or Column.

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

To see all components in action:

```bash
cd samples/client/angular
npm start -- gallery
```

## Further Reading

> NOTE: Schema Files
>
> === "v0.8"
>
>     [:material-code-json: Standard Catalog Definition (JSON Schema)](../../specification/v0_8/json/standard_catalog_definition.json)
>
> === "v0.9"
>
>     [:material-code-json: Basic Catalog Definition (JSON Schema)](../../specification/v0_9/json/basic_catalog.json)

- **[Defining Your Own Catalog](../guides/defining-your-own-catalog.md)**: Build your own components
- **[Theming Guide](../guides/theming.md)**: Style components to match your brand

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
