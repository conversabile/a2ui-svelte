# Theming and styling

This guide covers two layers of customisation:

1. **Token overrides** — change colours, radii, spacing for the entire
   default catalog with a few CSS variable overrides.
2. **Custom catalog** — replace one or more components with your own
   versions, no fork required.

It also walks through dark-mode wiring and the Pico CSS interplay
(Pico is supported but not required).

## Layer 1 — CSS variable tokens

The library ships `renderer/styles.css`. Import it once in your app's
global stylesheet:

```css
/* src/app.css */
@import 'a2ui-svelte/renderer/styles.css';
```

This declares a `:root` block of `--a2ui-*` tokens. Each one defaults
to a Pico CSS variable (when one exists) and falls back to a plain
literal when Pico isn't loaded.

### Token reference

| Token                          | Defaults to                              | Controls                       |
|--------------------------------|------------------------------------------|--------------------------------|
| `--a2ui-spacing`               | `--pico-spacing` (1rem)                  | Default container gap          |
| `--a2ui-border-radius`         | `--pico-border-radius` (0.25rem)         | Generic border radius          |
| `--a2ui-font-family`           | `--pico-font-family` (system-ui)         | Default font stack             |
| `--a2ui-card-bg`               | `--pico-card-background-color` (#fff)    | Card surface                   |
| `--a2ui-card-border`           | secondary 25% mix                        | Card border colour             |
| `--a2ui-card-radius`           | `--a2ui-border-radius`                   | Card corner radius             |
| `--a2ui-button-primary-bg`     | `--pico-primary` (#1095c1)               | Primary button background      |
| `--a2ui-button-primary-fg`     | `--pico-primary-inverse` (#fff)          | Primary button text            |
| `--a2ui-button-secondary-bg`   | `transparent`                            | Secondary button background    |
| `--a2ui-button-secondary-fg`   | `--pico-secondary` (#525252)             | Secondary button text          |
| `--a2ui-input-bg`              | `--pico-form-element-background-color`   | Input background               |
| `--a2ui-input-border`          | `--pico-form-element-border-color`       | Input border                   |
| `--a2ui-input-fg`              | `--pico-form-element-color`              | Input text                     |
| `--a2ui-glow-color`            | `--pico-primary-focus`                   | Agent action glow              |
| `--a2ui-shell-bg`              | `--pico-card-background-color`           | `<VoiceShell>` panel background |
| `--a2ui-shell-border`          | `--pico-muted-border-color`              | `<VoiceShell>` border          |
| `--a2ui-shell-glow`            | `--pico-primary-focus`                   | `<VoiceShell>` active glow     |
| `--a2ui-shell-border-active`   | `--pico-primary-border`                  | `<VoiceShell>` active border   |

### Override example

```css
/* src/app.css — after the import */
:root {
  --a2ui-border-radius: 12px;
  --a2ui-card-radius: 16px;
  --a2ui-button-primary-bg: #6d28d9;
  --a2ui-button-primary-fg: #ffffff;
  --a2ui-glow-color: rgba(109, 40, 217, 0.5);
}
```

That's it — every catalog component, every dynamic surface, every
mounted `<VoiceShell>` picks up the new look.

### Dark mode

The library doesn't ship a theme switcher; the convention is
`data-theme="dark"` on `<html>` (Pico's default attribute) and an
override block in your CSS:

```css
[data-theme='dark'] {
  --a2ui-card-bg: #1a1a1a;
  --a2ui-input-bg: #222;
  --a2ui-input-fg: #eee;
  --a2ui-input-border: #444;
  --a2ui-button-primary-bg: #818cf8;
  --a2ui-glow-color: rgba(129, 140, 248, 0.5);
  --a2ui-shell-bg: #111;
}
```

Toggle in JavaScript:

```ts
document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
```

If you load Pico CSS, Pico's own dark mode flips the `--pico-*`
variables and the `--a2ui-*` tokens follow automatically. You only
need the override block above for tokens that resolve to
non-`--pico-*` defaults.

## Layer 2 — Custom catalog

When tokens aren't enough — different DOM structure, different
interaction model, integrate with your design system — write a
replacement Svelte component and register it through `extendCatalog`.

### Step 1 — Write the replacement

```svelte
<!-- src/lib/components/MyButton.svelte -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { defineA2uiComponent } from 'a2ui-svelte/authoring';

  interface Props {
    children?: Snippet;
    id?: string;
    primary?: boolean;
    label?: string;
    action?: { name: string };
    onclick?: () => void;
  }
  let { children, id, primary = false, label, action, onclick }: Props = $props();

  const handle = defineA2uiComponent({
    type: 'Button',
    id: id ?? action?.name,
    a2ui: () => ({ primary, action }),
    action: action ? { type: 'click', handler: () => onclick?.() } : undefined
  });

  export const dataAttr = handle.dataAttr;
  export const fire = handle.fire;
  export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
  <button {...dataAttr}
          class="my-btn {primary ? 'is-primary' : 'is-secondary'}"
          onclick={() => handle.fire()}>
    {#if children}{@render children()}{:else if label}{label}{/if}
  </button>
{/if}

<style>
  .my-btn { /* your design system here */ }
</style>
```

The contract is the same as the built-in `Button`: same `type` name,
same exported handle. Consumers using `<Button>` from your replacement
catalog get your version transparently.

### Step 2 — Register it

```ts
// src/lib/catalog.ts
import { DEFAULT_CATALOG, extendCatalog } from 'a2ui-svelte/authoring';
import MyButton from './components/MyButton.svelte';

export const catalog = extendCatalog(DEFAULT_CATALOG, { Button: MyButton });
```

### Step 3 — Apply it

For dynamic surfaces, pass the catalog as a prop:

```svelte
<DynamicSurface surfaceId="canvas" {catalog} />
```

For an entire route subtree, set it via context in a layout:

```svelte
<!-- src/routes/(themed)/+layout.svelte -->
<script lang="ts">
  import { setCatalog } from 'a2ui-svelte/authoring';
  import { catalog } from '$lib/catalog';
  setCatalog(catalog);
</script>
<slot />
```

For your own static-surface code, just import `MyButton` directly
instead of the library's `Button` — no catalog magic needed.

### Per-route theming

`setCatalog` is scoped via Svelte context, so different routes can use
different catalogs:

```
src/routes/
├── (default)/+layout.svelte    # uses DEFAULT_CATALOG
└── (admin)/+layout.svelte      # setCatalog(adminCatalog)
```

## Choosing between layers

- **Just colours / sizes / radii?** Token overrides. One CSS file, no
  Svelte changes.
- **Different DOM, different behaviour, integrate with a design
  system?** Custom catalog. Each replacement component is ~30 lines.
- **Both?** Use them together. Tokens are the broad strokes; the custom
  catalog is the fine detail.

## Pitfalls

- **Hardcoded colours in catalog overrides.** Don't `background: blue`
  — use `var(--a2ui-button-primary-bg)` or your own design system's
  variables. Keeps theming composable.
- **Forgetting `{#if !handle.isHidden}`.** Required so composites
  (`<A2UIRepresentation>`) work with your replacement. Without it, the
  composite pattern leaks visible markup.
- **Tweaking `renderer/styles.css` directly.** Don't fork it. Override
  the tokens in your own stylesheet — your overrides survive library
  upgrades.
