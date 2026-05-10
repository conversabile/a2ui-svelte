---
name: style-and-theme
description: Use to change the look of A2UI components (colours, sizes, dark mode) without forking — either via CSS variable tokens or by registering a custom catalog.
type: skill
---

# Style and theme A2UI components

## When to use this skill

Use this skill when:

- You want different button colours / card radii / fonts / glow colours
  for the built-in catalog.
- You want a dark-mode variant.
- You want to drop Pico CSS entirely and use your own design system.
- You want to replace a *single* built-in (e.g. `Button`) with your own
  styled version while keeping the rest.

Trigger phrases: "theme the components", "change the button colour",
"dark mode", "drop Pico", "swap in our design system".

## How to apply

### 1. Override CSS variable tokens

The library ships `renderer/styles.css` with a `:root` block of
`--a2ui-*` tokens. Each token defaults to a Pico CSS variable when
present and a hard-coded fallback otherwise. Override any of them in
your app's stylesheet — that's the simplest path.

Token reference (from `renderer/styles.css`):

| Token                        | Defaults to                       | What it controls           |
|------------------------------|-----------------------------------|----------------------------|
| `--a2ui-spacing`             | `--pico-spacing`                  | Default container gap      |
| `--a2ui-border-radius`       | `--pico-border-radius`            | Generic border radius      |
| `--a2ui-font-family`         | `--pico-font-family`              | Default font               |
| `--a2ui-card-bg`             | `--pico-card-background-color`    | Card surface               |
| `--a2ui-card-border`         | (computed)                        | Card border colour         |
| `--a2ui-card-radius`         | `--a2ui-border-radius`            | Card corner radius         |
| `--a2ui-button-primary-bg`   | `--pico-primary`                  | Primary button background  |
| `--a2ui-button-primary-fg`   | `--pico-primary-inverse`          | Primary button text colour |
| `--a2ui-button-secondary-bg` | `transparent`                     | Secondary button background|
| `--a2ui-button-secondary-fg` | `--pico-secondary`                | Secondary button text      |
| `--a2ui-input-bg`            | `--pico-form-element-background-color` | Input background     |
| `--a2ui-input-border`        | `--pico-form-element-border-color`     | Input border         |
| `--a2ui-input-fg`            | `--pico-form-element-color`            | Input text colour    |
| `--a2ui-glow-color`          | `--pico-primary-focus`            | Agent-action glow          |

Example override (20 lines):

```css
/* src/app.css */
@import 'a2ui-svelte/renderer/styles.css';

:root {
  --a2ui-border-radius: 12px;
  --a2ui-card-radius: 16px;
  --a2ui-button-primary-bg: #6d28d9;        /* indigo */
  --a2ui-button-primary-fg: #ffffff;
  --a2ui-glow-color: rgba(109, 40, 217, 0.5);
}
```

### 2. Per-component override via custom catalog

When tokens aren't enough — say you want a fully custom Button with a
different DOM structure or hover behaviour — write a Svelte component
with `defineA2uiComponent` and register it with `extendCatalog`:

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
</script>

{#if !handle.isHidden}
  <button {...handle.dataAttr}
          class="my-btn {primary ? 'is-primary' : ''}"
          onclick={() => handle.fire()}>
    {#if children}{@render children()}{:else if label}{label}{/if}
  </button>
{/if}

<style>
  .my-btn { /* your design system here */ }
</style>
```

Register it (once, at app boot or in `+layout.svelte`):

```ts
import { DEFAULT_CATALOG, extendCatalog, setCatalog } from 'a2ui-svelte/authoring';
import MyButton from '$lib/components/MyButton.svelte';

setCatalog(extendCatalog(DEFAULT_CATALOG, { Button: MyButton }));
```

Now every `<Button>` import — and every dynamic surface render of a
`Button` component — uses your version.

### 3. Pico CSS interplay

The library is **Pico-friendly but not Pico-dependent**. Each
`--a2ui-*` token reads a `--pico-*` variable when present and falls
back to a sensible plain default otherwise. Practical guidance:

- **Loading Pico** (anywhere in your app's CSS chain) makes the
  defaults blend automatically. Most users want this.
- **Not loading Pico** — the fallbacks kick in and the components look
  reasonable without further work.
- **Replacing Pico** — set your own `--pico-*` variables (or override
  the `--a2ui-*` tokens directly to skip the Pico layer entirely).

### 4. Dark mode pattern

The convention is `data-theme="dark"` on `<html>` or `<body>`. Override
tokens in a `[data-theme="dark"]` block:

```css
[data-theme='dark'] {
  --a2ui-card-bg: #1a1a1a;
  --a2ui-input-bg: #222;
  --a2ui-input-fg: #eee;
  --a2ui-input-border: #444;
  --a2ui-button-primary-bg: #818cf8;
  --a2ui-glow-color: rgba(129, 140, 248, 0.5);
}
```

Toggle in your app:

```ts
document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
```

If you use Pico's own dark-mode handling, the Pico variables flip
automatically and the `--a2ui-*` tokens follow without extra work.

## Common variations

- **Theme one component differently from the rest.** Combine token
  overrides with per-component overrides — `--a2ui-button-primary-bg`
  for general buttons, plus a custom `Button` registered for one route
  via `setCatalog` inside its `+layout.svelte`.
- **Per-route theme.** `setCatalog` in a `+layout.svelte` script block
  scopes the catalog to that route subtree.
- **Hide the agent glow.** Set `--a2ui-glow-color: transparent` to
  disable the highlight animation if it conflicts with your design.

## Related skills

- `build-custom-component` — for new spec types.
- `build-composite-component` — when bespoke HTML matters more than
  pure CSS theming.
