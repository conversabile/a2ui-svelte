<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { SurfaceRegistry, setSurfaceContext, setParentId } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';
	import { validateSurface, formatSurfaceIssues } from '../core/validate-surface';
	import {
		registerSurface,
		unregisterSurface,
		type AgentSurface
	} from '../core/registries/surface-index';
	import type { Snippet } from 'svelte';
	import './styles.css';
	import '../core/dev-global';

	interface Props {
		surfaceId: string;
		children: Snippet;
	}

	let { surfaceId, children }: Props = $props();

	// Create registry for static surface
	const registry = new SurfaceRegistry(surfaceId);
	setSurfaceContext(registry);
	setParentId('root');

	// The handle the agent reads this surface through. Joins the global surface
	// index on mount (never at module scope — that would leave an entry behind
	// after a server render) so the agent's default surface source finds it. The index
	// is also what installs the built-in tools (`click_button`,
	// `update_text_field`, …) while any static surface is up: they target
	// elements through the global `actionRegistry`, so they are page-wide, not
	// per-surface.
	const handle: AgentSurface = {
		id: surfaceId,
		type: 'static',
		getJson: () => registry.toJSON(),
		getDataModel: () => registry.getDataModel()
	};
	onMount(() => {
		validateOnMount();
		return registerSurface(handle);
	});

	/**
	 * Check the serialized tree once the whole surface has mounted (every
	 * descendant has registered by then, so this is the first moment the JSON
	 * is complete).
	 *
	 * An error here is a deterministic bug — in our serializer or in the
	 * author's markup — that would make the agent misread the page, so it
	 * fails loudly instead of shipping a surface the agent can't drive. Runs
	 * in production too: a surface that confuses the agent confuses it there
	 * as well, and behaviour that differs between dev and prod is behaviour
	 * nobody can reason about.
	 */
	function validateOnMount(): void {
		const issues = validateSurface(handle.getJson());
		const errors = issues.filter((i) => i.severity === 'error');
		const warnings = issues.filter((i) => i.severity === 'warning');
		if (warnings.length > 0) {
			console.warn(
				`[A2UI] Surface "${surfaceId}" — ${warnings.length} validation warning(s):\n${formatSurfaceIssues(warnings)}`
			);
		}
		if (errors.length > 0) {
			const detail = `[A2UI] Surface "${surfaceId}" is not A2UI-compliant:\n${formatSurfaceIssues(errors)}`;
			console.error(detail);
			throw new Error(detail);
		}
	}

	// Clean up this surface's registry entries on destroy: its actions and its
	// entry in the surface index (which drops the built-in tools when this was
	// the last static surface on the page).
	onDestroy(() => {
		unregisterSurface(handle);
		actionRegistry.unregisterBySurface(surfaceId);
	});

	// Expose properties for GeminiLive (or other controllers)
	export const id = surfaceId;
	export const type = 'static';
	export const getJson = handle.getJson;
	/**
	 * The surface's `{ fieldId → value }` data model — the unit the
	 * `Agent` syncs in `'sync'` mode (A2UI v0.9). Decoupled from the
	 * component tree so a keystroke ships as a tiny delta, not the whole tree.
	 */
	export const getDataModel = handle.getDataModel!;
</script>

<div class="a2ui-surface a2ui-static-surface" data-surface-id={surfaceId}>
	{@render children()}
</div>

<style>
	/* Surface-specific styles are now in styles.css */
</style>
