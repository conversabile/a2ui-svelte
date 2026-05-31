<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		id?: string;
		label?: string;
		/**
		 * Current value. When both date and time are enabled this is an
		 * ISO-8601 `datetime-local` string (`YYYY-MM-DDTHH:mm`); date-only is
		 * `YYYY-MM-DD`; time-only is `HH:mm`.
		 */
		value?: string;
		/** Field name used for data binding and action registration. */
		fieldName?: string;
		enableDate?: boolean;
		enableTime?: boolean;
		onchange?: (value: string) => void | Promise<void>;
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
		value = $bindable(''),
		fieldName,
		enableDate = true,
		enableTime = false,
		onchange,
		disabled = false,
		accessibility,
		weight,
		class: className = '',
		_a2uiSetters
	}: Props = $props();

	function pushToSurfaceData(next: string) {
		_a2uiSetters?.value?.(next);
	}

	// Pick the native input type from the enabled date/time facets.
	const inputType = $derived(
		enableDate && enableTime ? 'datetime-local' : enableTime ? 'time' : 'date'
	);

	const handle = defineA2uiComponent<{
		value: string;
		enableDate: boolean;
		enableTime: boolean;
	}>({
		type: 'DateTimeInput',
		id: id ?? fieldName,
		// See TextField: path-bind the value under `fieldName ?? componentId` and
		// always register it as a data source.
		a2ui: (componentId) => {
			const bindingKey = fieldName ?? componentId;
			return {
				...(label ? { label: { literalString: label } } : {}),
				value: bindingKey ? { path: `/${bindingKey}` } : { literalString: value },
				enableDate,
				enableTime,
				...(accessibility ? { accessibility } : {}),
				...(weight != null ? { weight } : {})
			};
		},
		data: { key: fieldName, value: () => value },
		action: {
			type: 'update',
			handler: async (next: string): Promise<unknown> => {
				value = next;
				await onchange?.(value);
				return {
					field: fieldName ?? id ?? '',
					message: `"${label ?? 'Date/time'}" set to ${value}.`
				};
			}
		}
	});

	async function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		value = target.value;
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
		class="a2ui-datetime {className}"
		style={handle.weightStyle}
	>
		{#if label}<label for={id}>{label}</label>{/if}
		<input
			type={inputType}
			{id}
			{disabled}
			{value}
			oninput={handleInput}
			onblur={handleInput}
		/>
	</div>
{/if}

<style>
	.a2ui-datetime {
		margin-bottom: 0;
	}
	.a2ui-datetime label {
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
</style>
