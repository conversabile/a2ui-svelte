<script lang="ts" module>
	/**
	 * Built-in icon set for the A2UI `Icon` component.
	 *
	 * The glyphs are drawn from the **Lucide** icon set (https://lucide.dev,
	 * ISC licensed) — a curated subset, kept inline so the library has no
	 * runtime dependency. Each entry is the inner markup of a 24×24 SVG with
	 * `fill="none" stroke="currentColor"`.
	 *
	 * To extend the set, register your own type in a custom catalog, or wrap
	 * `Icon` and pass a larger map. Unknown names fall back to rendering the
	 * name as text so the surface stays debuggable.
	 */
	export const A2UI_ICONS: Record<string, string> = {
		check: '<path d="M20 6 9 17l-5-5"/>',
		x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
		plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
		minus: '<path d="M5 12h14"/>',
		search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
		menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
		home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
		user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
		calendar:
			'<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
		clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
		trash:
			'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
		edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
		info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
		alert:
			'<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
		star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
		heart:
			'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
		mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
		settings:
			'<circle cx="12" cy="12" r="3"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
		'chevron-right': '<path d="m9 18 6-6-6-6"/>',
		'chevron-left': '<path d="m15 18-6-6 6-6"/>',
		'chevron-down': '<path d="m6 9 6 6 6-6"/>',
		'chevron-up': '<path d="m18 15-6-6-6 6"/>'
	};
</script>

<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		id?: string;
		/** Icon name; must be a key of the built-in Lucide subset (`A2UI_ICONS`). */
		name: string;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let { id, name, accessibility, weight, class: className = '' }: Props = $props();

	const handle = defineA2uiComponent<{ name: string }>({
		type: 'Icon',
		id,
		a2ui: () => ({
			name: { literalString: name },
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		})
	});

	const glyph = $derived(A2UI_ICONS[handle.resolved.name]);

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	{#if glyph}
		<svg
			{...handle.dataAttr}
			{...handle.a11yAttr}
			class="a2ui-icon {className}"
			role={accessibility?.role ?? 'img'}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			style={handle.weightStyle}
		>
			{@html glyph}
		</svg>
	{:else}
		<!-- Unknown icon name: render the name so the surface stays debuggable. -->
		<span {...handle.dataAttr} {...handle.a11yAttr} class="a2ui-icon-fallback {className}"
			>{handle.resolved.name}</span
		>
	{/if}
{/if}

<style>
	.a2ui-icon {
		display: inline-block;
		width: 1.25em;
		height: 1.25em;
		vertical-align: middle;
	}
	.a2ui-icon-fallback {
		font-size: 0.75rem;
		color: var(--pico-muted-color, #888);
	}
</style>
