<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { getSurfaceContext, getParentId } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';

	export interface AutocompleteOption {
		/** The value stored in `value` when this option is selected (e.g. a full CRL). */
		value: string;
		/** The human-readable label shown in the dropdown and in the input when selected. */
		label: string;
		/** Optional secondary text displayed in the dropdown next to the label. */
		sublabel?: string;
		/** Optional section heading; options sharing a `group` are rendered together. */
		group?: string;
	}

	export interface AutocompleteFooterOption {
		/** Label rendered in the sticky footer entry. May contain a `{query}` placeholder. */
		label: string;
		/** Called when the footer entry is activated. Receives the current input query. */
		onSelect: (query: string) => void;
	}

	interface Props {
		id?: string;
		label?: string;
		value?: string;
		/** The text currently typed by the user. Bindable so parents can read it on submit. */
		query?: string;
		fieldName?: string;
		options: AutocompleteOption[];
		placeholder?: string;
		onchange?: (value: string) => void;
		class?: string;
		/** Optional sticky footer entry shown at the bottom of the dropdown regardless of filter. */
		footerOption?: AutocompleteFooterOption;
	}

	let {
		id,
		label,
		value = $bindable(''),
		query = $bindable(''),
		fieldName,
		options,
		placeholder = '',
		onchange,
		class: className = '',
		footerOption
	}: Props = $props();

	// ---- Human-facing UI state ----
	let open = $state(false);
	let highlighted = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();
	let blurTimer: ReturnType<typeof setTimeout> | undefined;

	/** The currently-selected option (if any), derived from `value`. */
	const selectedOption = $derived(options.find((o) => o.value === value));

	/**
	 * What the input displays:
	 * - while open → the user's current query
	 * - while closed and an option is selected → that option's label
	 * - while closed and value is set but no matching option → the raw value (agent path)
	 * - otherwise empty
	 */
	const displayValue = $derived(
		open ? query : selectedOption ? selectedOption.label : value || ''
	);

	/** Options filtered by the current query (case-insensitive substring on label + sublabel). */
	const filtered = $derived.by(() => {
		if (!open) return options;
		const q = query.trim().toLowerCase();
		if (!q) return options;
		return options.filter((o) => {
			const hay = `${o.label} ${o.sublabel ?? ''}`.toLowerCase();
			return hay.includes(q);
		});
	});

	/** Filtered options grouped in original order, preserving group headings. */
	const groupedFiltered = $derived.by(() => {
		const groups: Array<{ group: string | undefined; items: AutocompleteOption[] }> = [];
		for (const opt of filtered) {
			const last = groups[groups.length - 1];
			if (last && last.group === opt.group) {
				last.items.push(opt);
			} else {
				groups.push({ group: opt.group, items: [opt] });
			}
		}
		return groups;
	});

	function openPopover() {
		if (open) return;
		open = true;
		query = '';
		highlighted = 0;
	}

	function closePopover() {
		open = false;
		query = '';
	}

	function selectOption(opt: AutocompleteOption) {
		value = opt.value;
		closePopover();
		onchange?.(value);
	}

	function clearSelection() {
		if (value === '') return;
		value = '';
		onchange?.('');
	}

	function handleFocus() {
		if (blurTimer) {
			clearTimeout(blurTimer);
			blurTimer = undefined;
		}
		openPopover();
	}

	function handleBlur() {
		// Delay so that clicks on option items register before we close.
		blurTimer = setTimeout(() => {
			closePopover();
		}, 150);
	}

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		query = target.value;
		highlighted = 0;
		if (!open) open = true;
		// Typing invalidates a stale selection: if the user is typing something other
		// than the currently selected option's label, clear the selection so the parent
		// can treat the typed query as a fresh intent.
		if (value !== '' && (!selectedOption || target.value !== selectedOption.label)) {
			value = '';
			onchange?.('');
		}
	}

	function activateFooter() {
		if (!footerOption) return;
		const q = query;
		closePopover();
		footerOption.onSelect(q);
	}

	/** Total navigable rows: filtered options + (1 if footer present). */
	const navCount = $derived(filtered.length + (footerOption ? 1 : 0));

	async function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (!open) {
				openPopover();
				return;
			}
			highlighted = Math.min(highlighted + 1, navCount - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlighted = Math.max(highlighted - 1, 0);
		} else if (e.key === 'Enter') {
			if (open) {
				if (footerOption && highlighted === filtered.length) {
					e.preventDefault();
					activateFooter();
				} else if (filtered[highlighted]) {
					e.preventDefault();
					selectOption(filtered[highlighted]);
				}
			}
		} else if (e.key === 'Escape') {
			if (open) {
				e.preventDefault();
				closePopover();
				await tick();
				inputEl?.blur();
			}
		}
	}

	// ---- A2UI self-registration (only when inside a static Surface) ----
	const ctx = getSurfaceContext();
	let _componentId: string | undefined;
	if (ctx) {
		const parentId = getParentId();
		_componentId = id || fieldName || ctx.generateId('autocomplete');

		const textProp: Record<string, any> = {};
		if (fieldName) {
			textProp.path = `/${fieldName}`;
			ctx.registerData(fieldName, () => value);
		} else {
			textProp.literalString = value;
		}

		// Register as a standard A2UI TextField so the surface JSON stays spec-compliant
		// and the agent keeps interacting via the generic update_text_field tool.
		ctx.register(_componentId, parentId, {
			TextField: {
				label: label ? { literalString: label } : undefined,
				text: textProp,
				textFieldType: 'shortText'
			}
		});

		// Update callback for update_text_field: agent passes the full option.value (e.g. a CRL).
		if (fieldName) {
			actionRegistry.register(
				_componentId,
				'update',
				(newValue: string) => {
					value = newValue;
					onchange?.(value);
					return { field: fieldName, message: `Field "${label || fieldName}" updated.` };
				},
				ctx.surfaceId
			);
		}
	}

	onDestroy(() => {
		if (blurTimer) clearTimeout(blurTimer);
		if (ctx && _componentId) {
			actionRegistry.unregister(_componentId);
			ctx.unregister(_componentId);
			if (fieldName) ctx.unregisterData(fieldName);
		}
	});
</script>

<div class="autocomplete-field {className}" {id} data-a2ui-id={_componentId}>
	{#if label}
		<label for="{_componentId}-input">{label}</label>
	{/if}
	<div class="combo" class:open>
		<input
			bind:this={inputEl}
			id="{_componentId}-input"
			type="text"
			role="combobox"
			aria-expanded={open}
			aria-autocomplete="list"
			aria-controls="{_componentId}-listbox"
			autocomplete="off"
			{placeholder}
			value={displayValue}
			oninput={handleInput}
			onfocus={handleFocus}
			onblur={handleBlur}
			onkeydown={handleKeydown}
		/>
		{#if value && !open}
			<button
				type="button"
				class="clear-btn"
				aria-label="Clear selection"
				onmousedown={(e) => {
					e.preventDefault();
					clearSelection();
				}}>×</button
			>
		{/if}
		{#if open}
			<ul id="{_componentId}-listbox" class="popover" role="listbox">
				{#if filtered.length === 0 && !footerOption}
					<li class="empty">No matches</li>
				{:else}
					{#each groupedFiltered as section (section.group ?? '__nogroup__')}
						{#if section.group}
							<li class="group-heading">{section.group}</li>
						{/if}
						{#each section.items as opt (opt.value)}
							{@const idx = filtered.indexOf(opt)}
							<li
								role="option"
								aria-selected={idx === highlighted}
								class="option"
								class:highlighted={idx === highlighted}
								onmousedown={(e) => {
									e.preventDefault();
									selectOption(opt);
								}}
								onmouseenter={() => (highlighted = idx)}
							>
								<span class="opt-label">{opt.label}</span>
								{#if opt.sublabel}
									<span class="opt-sublabel">{opt.sublabel}</span>
								{/if}
							</li>
						{/each}
					{/each}
				{/if}
				{#if footerOption}
					{@const footerIdx = filtered.length}
					<li
						role="option"
						aria-selected={footerIdx === highlighted}
						class="option footer-option"
						class:highlighted={footerIdx === highlighted}
						onmousedown={(e) => {
							e.preventDefault();
							activateFooter();
						}}
						onmouseenter={() => (highlighted = footerIdx)}
					>
						<span class="opt-label">{footerOption.label.replace('{query}', query)}</span>
					</li>
				{/if}
			</ul>
		{/if}
	</div>
</div>

<style>
	.autocomplete-field {
		flex: 1;
		min-width: 0;
		margin-bottom: 0;
	}

	.autocomplete-field label {
		display: block;
		margin-bottom: 0.25rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.combo {
		position: relative;
	}

	.combo input {
		width: 100%;
		margin-bottom: 0;
		padding-right: 2rem;
	}

	.clear-btn {
		position: absolute;
		right: 0.4rem;
		top: 50%;
		transform: translateY(-50%);
		background: none;
		border: none;
		cursor: pointer;
		color: var(--pico-muted-color);
		font-size: 1.2rem;
		line-height: 1;
		padding: 0 0.25rem;
		margin: 0;
		width: auto;
	}

	.clear-btn:hover {
		color: var(--pico-del-color);
	}

	.popover {
		position: absolute;
		z-index: 50;
		top: calc(100% + 2px);
		left: 0;
		right: 0;
		max-height: 18rem;
		overflow-y: auto;
		margin: 0;
		padding: 0.25rem 0;
		list-style: none;
		background: var(--pico-card-background-color);
		border: 1px solid var(--pico-form-element-border-color);
		border-radius: var(--pico-border-radius);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	}

	.popover .empty {
		padding: 0.5rem 0.75rem;
		color: var(--pico-muted-color);
		font-style: italic;
	}

	.popover .group-heading {
		padding: 0.35rem 0.75rem 0.2rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--pico-muted-color);
		font-weight: 600;
	}

	.popover .option {
		padding: 0.4rem 0.75rem;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.popover .option.highlighted {
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
	}

	.popover .opt-label {
		font-size: 0.9rem;
	}

	.popover .opt-sublabel {
		font-size: 0.75rem;
		color: var(--pico-muted-color);
	}

	.popover .option.highlighted .opt-sublabel {
		color: var(--pico-primary-inverse);
		opacity: 0.85;
	}

	.popover .footer-option {
		position: sticky;
		bottom: 0;
		background: var(--pico-card-background-color);
		border-top: 1px solid var(--pico-form-element-border-color);
		font-weight: 600;
		color: var(--pico-primary);
	}

	.popover .footer-option.highlighted {
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
	}
</style>
