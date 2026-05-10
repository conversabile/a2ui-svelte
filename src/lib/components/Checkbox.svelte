<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getSurfaceContext, getParentId } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';

	interface Props {
		id?: string;
		label: string;
		fieldName?: string;
		checked?: boolean;
		onchange?: (next: boolean) => void | Promise<void>;
		disabled?: boolean;
		class?: string;
	}

	let {
		id,
		label,
		fieldName,
		checked = $bindable(false),
		onchange,
		disabled = false,
		class: className = ''
	}: Props = $props();

	const ctx = getSurfaceContext();
	let _componentId: string | undefined;
	if (ctx) {
		const parentId = getParentId();
		_componentId = id || fieldName || ctx.generateId('checkbox');

		const valueProp: Record<string, any> = {};
		if (fieldName) {
			valueProp.path = `/${fieldName}`;
			ctx.registerData(fieldName, () => checked);
		} else {
			valueProp.literalBoolean = checked;
		}

		ctx.register(_componentId, parentId, {
			CheckBox: {
				label: { literalString: label },
				value: valueProp
			}
		});

		actionRegistry.register(
			_componentId,
			'click',
			async () => {
				checked = !checked;
				await onchange?.(checked);
				return { field: fieldName ?? _componentId!, message: `"${label}" set to ${checked}.` };
			},
			ctx.surfaceId
		);

		actionRegistry.register(
			_componentId,
			'update',
			async (next: unknown) => {
				const asBool =
					typeof next === 'boolean'
						? next
						: typeof next === 'string'
							? next.toLowerCase() === 'true'
							: Boolean(next);
				checked = asBool;
				await onchange?.(checked);
				return { field: fieldName ?? _componentId!, message: `"${label}" set to ${checked}.` };
			},
			ctx.surfaceId
		);
	}

	onDestroy(() => {
		if (ctx && _componentId) {
			actionRegistry.unregister(_componentId);
			ctx.unregister(_componentId);
			if (fieldName) ctx.unregisterData(fieldName);
		}
	});

	async function handleChange(e: Event) {
		const target = e.target as HTMLInputElement;
		checked = target.checked;
		await onchange?.(checked);
	}
</script>

<label class="checkbox {className}" data-a2ui-id={_componentId}>
	<input type="checkbox" {id} checked={checked} {disabled} onchange={handleChange} />
	<span class="label-text">{label}</span>
</label>

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
