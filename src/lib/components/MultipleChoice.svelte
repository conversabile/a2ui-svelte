<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Option {
		label: string;
		value: string;
	}

	interface Props {
		id?: string;
		label?: string;
		/** Selectable options. */
		options: Option[];
		/** Currently-selected option values. */
		selections?: string[];
		/** Field name used for data binding and action registration. */
		fieldName?: string;
		/** Max number of options selectable at once. `1` renders radios. */
		maxAllowedSelections?: number;
		onchange?: (selections: string[]) => void | Promise<void>;
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
		options,
		selections = $bindable([]),
		fieldName,
		maxAllowedSelections = 1,
		onchange,
		disabled = false,
		accessibility,
		weight,
		class: className = '',
		_a2uiSetters
	}: Props = $props();

	const single = $derived(maxAllowedSelections === 1);

	function pushToSurfaceData(next: string[]) {
		_a2uiSetters?.selections?.(next);
	}

	/**
	 * Parse an incoming agent value into a list of selected option values.
	 * Accepts a JSON array string, a comma-separated list, or a single value.
	 */
	function parseSelections(raw: string): string[] {
		const trimmed = raw.trim();
		let parsed: string[];
		if (trimmed.startsWith('[')) {
			try {
				const arr = JSON.parse(trimmed);
				parsed = Array.isArray(arr) ? arr.map(String) : [trimmed];
			} catch {
				parsed = [trimmed];
			}
		} else if (trimmed.includes(',')) {
			parsed = trimmed.split(',').map((s) => s.trim());
		} else {
			parsed = trimmed ? [trimmed] : [];
		}
		// Keep only known option values, then clamp to the allowed maximum.
		const valid = parsed.filter((v) => options.some((o) => o.value === v));
		return valid.slice(0, Math.max(1, maxAllowedSelections));
	}

	const handle = defineA2uiComponent<{ options: Option[]; maxAllowedSelections: number }>({
		type: 'MultipleChoice',
		id: id ?? fieldName,
		a2ui: () => ({
			...(label ? { label: { literalString: label } } : {}),
			options: options.map((o) => ({ label: { literalString: o.label }, value: o.value })),
			...(fieldName ? { selections: { path: `/${fieldName}` } } : {}),
			maxAllowedSelections,
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		data: fieldName ? { key: fieldName, value: () => selections } : undefined,
		action: {
			type: 'update',
			handler: async (next: string): Promise<unknown> => {
				selections = parseSelections(next);
				await onchange?.(selections);
				return {
					field: fieldName ?? id ?? '',
					message: `"${label ?? 'Choice'}" set to ${selections.join(', ') || '(none)'}.`
				};
			}
		}
	});

	async function commit(next: string[]) {
		selections = next;
		pushToSurfaceData(next);
		await onchange?.(next);
	}

	async function handleSingle(value: string) {
		await commit([value]);
	}

	async function handleMulti(value: string, checked: boolean) {
		let next = checked ? [...selections, value] : selections.filter((v) => v !== value);
		// Enforce the selection cap: drop the oldest selection when exceeded.
		if (next.length > maxAllowedSelections) next = next.slice(next.length - maxAllowedSelections);
		await commit(next);
	}

	export const dataAttr = handle.dataAttr;
	export const fire = handle.fire;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<fieldset
		{...handle.dataAttr}
		{...handle.a11yAttr}
		class="a2ui-multiple-choice {className}"
		style={handle.weightStyle}
		{disabled}
	>
		{#if label}<legend>{label}</legend>{/if}
		{#each options as opt (opt.value)}
			<label class="a2ui-choice-option">
				<input
					type={single ? 'radio' : 'checkbox'}
					name={id ?? fieldName ?? 'a2ui-choice'}
					value={opt.value}
					checked={selections.includes(opt.value)}
					{disabled}
					onchange={(e) =>
						single
							? handleSingle(opt.value)
							: handleMulti(opt.value, (e.target as HTMLInputElement).checked)}
				/>
				<span>{opt.label}</span>
			</label>
		{/each}
	</fieldset>
{/if}

<style>
	.a2ui-multiple-choice {
		border: none;
		padding: 0;
		margin-bottom: 0;
	}
	.a2ui-multiple-choice legend {
		font-weight: 600;
		margin-bottom: 0.25rem;
		padding: 0;
	}
	.a2ui-choice-option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		margin-bottom: 0.25rem;
	}
	.a2ui-choice-option input {
		margin: 0;
		flex-shrink: 0;
	}
</style>
