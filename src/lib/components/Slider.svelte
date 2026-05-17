<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		id?: string;
		label?: string;
		/** Current numeric value. */
		value?: number;
		/** Field name used for data binding and action registration. */
		fieldName?: string;
		minValue?: number;
		maxValue?: number;
		step?: number;
		onchange?: (value: number) => void | Promise<void>;
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
		value = $bindable(0),
		fieldName,
		minValue = 0,
		maxValue = 100,
		step = 1,
		onchange,
		disabled = false,
		accessibility,
		weight,
		class: className = '',
		_a2uiSetters
	}: Props = $props();

	function pushToSurfaceData(next: number) {
		_a2uiSetters?.value?.(next);
	}

	const handle = defineA2uiComponent<{ value: number; minValue: number; maxValue: number }>({
		type: 'Slider',
		id: id ?? fieldName,
		a2ui: () => ({
			...(label ? { label: { literalString: label } } : {}),
			value: fieldName ? { path: `/${fieldName}` } : { literalNumber: value },
			minValue,
			maxValue,
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		data: fieldName ? { key: fieldName, value: () => value } : undefined,
		action: {
			type: 'update',
			handler: async (next: string): Promise<unknown> => {
				const asNumber = typeof next === 'number' ? next : parseFloat(next);
				if (!Number.isNaN(asNumber)) value = asNumber;
				await onchange?.(value);
				return { field: fieldName ?? id ?? '', message: `"${label ?? 'Slider'}" set to ${value}.` };
			}
		}
	});

	async function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		value = target.valueAsNumber;
		pushToSurfaceData(value);
		await onchange?.(value);
	}

	export const dataAttr = handle.dataAttr;
	export const fire = handle.fire;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div
		{...handle.dataAttr}
		{...handle.a11yAttr}
		class="a2ui-slider {className}"
		style={handle.weightStyle}
	>
		{#if label}<label for={id}>{label}</label>{/if}
		<div class="a2ui-slider-row">
			<input
				type="range"
				{id}
				{disabled}
				min={minValue}
				max={maxValue}
				{step}
				{value}
				oninput={handleInput}
			/>
			<span class="a2ui-slider-value">{value}</span>
		</div>
	</div>
{/if}

<style>
	.a2ui-slider {
		margin-bottom: 0;
	}
	.a2ui-slider label {
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
	.a2ui-slider-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.a2ui-slider-row input[type='range'] {
		flex: 1;
		margin: 0;
	}
	.a2ui-slider-value {
		min-width: 2.5ch;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--pico-muted-color, #888);
	}
</style>
