<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';
	import { getSurfaceContext } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';

	interface Props {
		id?: string;
		label: string;
		fieldName?: string;
		checked?: boolean;
		onchange?: (next: boolean) => void | Promise<void>;
		disabled?: boolean;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
		/** Internal: injected by the dynamic-surface renderer; see TextField. */
		_a2uiSetters?: Record<string, (value: unknown) => void>;
	}

	let {
		id,
		label,
		fieldName,
		checked = $bindable(false),
		onchange,
		disabled = false,
		accessibility,
		weight,
		class: className = '',
		_a2uiSetters
	}: Props = $props();

	function pushToSurfaceData(next: boolean) {
		_a2uiSetters?.value?.(next);
	}

	const handle = defineA2uiComponent({
		type: 'CheckBox',
		id: id ?? fieldName,
		// See TextField: path-bind the value under `fieldName ?? componentId` and
		// always register it as a data source so its state lives in the data
		// model, not inline in the tree.
		a2ui: (componentId) => {
			const bindingKey = fieldName ?? componentId;
			return {
				label: { literalString: label },
				value: bindingKey ? { path: `/${bindingKey}` } : { literalBoolean: checked },
				...(accessibility ? { accessibility } : {}),
				...(weight != null ? { weight } : {})
			};
		},
		data: { key: fieldName, value: () => checked },
		action: {
			type: 'update',
			handler: async (next: string): Promise<unknown> => {
				const asBool =
					typeof next === 'string'
						? next.toLowerCase() === 'true'
						: Boolean(next);
				checked = asBool;
				await onchange?.(checked);
				return { field: fieldName ?? id ?? '', message: `"${label}" set to ${checked}.` };
			}
		}
	});

	// Checkbox supports two action verbs: 'update' (set explicit boolean) is
	// wired through defineA2uiComponent; 'click' (toggle) is added directly.
	const _ctx = getSurfaceContext();
	const _cbId = handle.componentId;
	if (_ctx && _cbId) {
		actionRegistry.register(
			_cbId,
			'click',
			async () => {
				checked = !checked;
				await onchange?.(checked);
				return { field: fieldName ?? _cbId, message: `"${label}" set to ${checked}.` };
			},
			_ctx.surfaceId
		);
	}

	async function handleChange(e: Event) {
		const target = e.target as HTMLInputElement;
		checked = target.checked;
		pushToSurfaceData(checked);
		await onchange?.(checked);
	}

	export const dataAttr = handle.dataAttr;
	export const fire = handle.fire;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<label class="checkbox {className}" {...dataAttr} {...handle.a11yAttr} style={handle.weightStyle}>
		<input type="checkbox" {id} {checked} {disabled} onchange={handleChange} />
		<span class="label-text">{label}</span>
	</label>
{/if}

<style>
	.checkbox {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		user-select: none;
		margin-bottom: 0;
		padding: 0.25rem 0;
	}

	.checkbox input {
		margin: 0;
		width: 1.1rem;
		height: 1.1rem;
		flex-shrink: 0;
	}

	.label-text {
		font-size: 0.9rem;
		line-height: 1.2;
	}

	.checkbox:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.6;
	}
</style>
