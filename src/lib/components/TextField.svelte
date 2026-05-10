<script lang="ts">
	import { tick } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';
	import { marked } from 'marked';

	interface Props {
		id?: string;
		label?: string;
		value?: string;
		/** A2UI dynamic surface alias for value */
		text?: string;
		textFieldType?: 'shortText' | 'longText' | 'number' | 'date' | 'time' | 'obscured';
		/** Field name used for data binding and action registration */
		fieldName?: string;
		onchange?: (value: string) => void;
		placeholder?: string;
		class?: string;
		disabled?: boolean;
		/**
		 * Render as inline editable text: looks like a normal span until clicked,
		 * then becomes an editable input. The A2UI registration is unchanged —
		 * the agent still interacts with this as a standard TextField.
		 */
		inline?: boolean;
		/** Static text shown next to the value in inline mode (e.g. "g", "%"). */
		suffix?: string;
	}

	let {
		id,
		label,
		value = $bindable(''),
		text,
		textFieldType = 'shortText',
		fieldName,
		onchange,
		placeholder = '',
		class: className = '',
		disabled = false,
		inline = false,
		suffix
	}: Props = $props();

	// Allow A2UI dynamic surface to pass `text` as an alias for `value`
	$effect(() => {
		if (text !== undefined && text !== value) value = text;
	});

	let isPreview = $state(true);
	let longTextAreaEl: HTMLTextAreaElement | undefined = $state();
	let longTextOriginal = '';

	// Render markdown
	let renderedMarkdown = $derived.by(() => {
		if (!value) return `<p style="color: var(--pico-muted-color);"><em>${placeholder || 'Nessun contenuto'}</em></p>`;
		return marked.parse(value, { async: false }) as string;
	});

	const handle = defineA2uiComponent({
		type: 'TextField',
		id: id ?? fieldName,
		a2ui: () => ({
			label: label ? { literalString: label } : undefined,
			text: fieldName ? { path: `/${fieldName}` } : { literalString: value },
			textFieldType
		}),
		data: fieldName ? { key: fieldName, value: () => value } : undefined,
		action: fieldName
			? {
					type: 'update',
					handler: (newValue: string) => {
						value = newValue;
						onchange?.(value);
						return { field: fieldName, message: `Field "${label || fieldName}" updated.` };
					}
				}
			: undefined
	});

	export const dataAttr = handle.dataAttr;
	export const fire = handle.fire;
	export const componentId = handle.componentId;

	function handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement | HTMLInputElement;
		value = target.value;
		onchange?.(value);
	}

	function handleBlur() {
		onchange?.(value);
	}

	async function enterLongTextEdit() {
		if (disabled) return;
		longTextOriginal = value;
		isPreview = false;
		await tick();
		longTextAreaEl?.focus();
	}

	function commitLongTextEdit() {
		isPreview = true;
		onchange?.(value);
	}

	function handleLongTextKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			value = longTextOriginal;
			isPreview = true;
		}
	}

	// ---- Inline mode state ----
	let isEditing = $state(false);
	let inlineInputEl: HTMLInputElement | undefined = $state();
	let inlineDraft = $state('');
	let inlineOriginal = '';

	const inlineInputType = $derived(
		textFieldType === 'number'
			? 'number'
			: textFieldType === 'date'
				? 'date'
				: textFieldType === 'time'
					? 'time'
					: textFieldType === 'obscured'
						? 'password'
						: 'text'
	);

	async function enterInlineEdit() {
		if (disabled || isEditing) return;
		inlineOriginal = value;
		inlineDraft = value;
		isEditing = true;
		await tick();
		inlineInputEl?.focus();
		inlineInputEl?.select?.();
	}

	function commitInlineEdit() {
		if (!isEditing) return;
		isEditing = false;
		if (inlineDraft !== inlineOriginal) {
			// Fire onchange with the draft. Don't mutate local `value` —
			// the parent owns the source of truth and will refresh the prop
			// after a successful update (or leave it untouched on validation
			// failure, so the UI snaps back to the canonical value).
			onchange?.(inlineDraft);
		}
	}

	function cancelInlineEdit() {
		if (!isEditing) return;
		isEditing = false;
		inlineDraft = inlineOriginal;
	}

	function handleInlineInput(e: Event) {
		const target = e.target as HTMLInputElement;
		inlineDraft = target.value;
	}

	function handleInlineKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitInlineEdit();
			inlineInputEl?.blur();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelInlineEdit();
			inlineInputEl?.blur();
		}
	}
</script>

{#if handle.isHidden}
	<!-- Hidden inside <A2UIRepresentation>: registers but renders nothing visible. -->
{:else if inline}
	<span class="inline-field {className}" {id} {...dataAttr}>
		{#if isEditing}
			<input
				bind:this={inlineInputEl}
				class="inline-input"
				type={inlineInputType}
				{placeholder}
				value={inlineDraft}
				oninput={handleInlineInput}
				onblur={commitInlineEdit}
				onkeydown={handleInlineKeydown}
			/>
		{:else}
			<button
				type="button"
				class="inline-display"
				class:empty={!value}
				{disabled}
				onclick={enterInlineEdit}
			>{value || placeholder || '—'}</button>
		{/if}
		{#if suffix}<span class="inline-suffix">{suffix}</span>{/if}
	</span>
{:else}
<div class="text-field-container {className}" {id} {...dataAttr}>
	{#if label}
		<div class="field-header">
			<label>{label}</label>
		</div>
	{/if}

	{#if textFieldType === 'longText'}
		{#if isPreview}
			<div
				class="markdown-preview outline secondary"
				class:clickable={!disabled}
				role="button"
				tabindex={disabled ? -1 : 0}
				onclick={enterLongTextEdit}
				onkeydown={(e) => e.key === 'Enter' && enterLongTextEdit()}
			>
				{@html renderedMarkdown}
			</div>
		{:else}
			<textarea
				bind:this={longTextAreaEl}
				{placeholder}
				{disabled}
				value={value}
				oninput={handleInput}
				onblur={commitLongTextEdit}
				onkeydown={handleLongTextKeydown}
				rows="10"
			></textarea>
		{/if}
	{:else if textFieldType === 'number'}
		<input
			type="number"
			{placeholder}
			{disabled}
			value={value}
			oninput={handleInput}
			onblur={handleBlur}
		/>
	{:else if textFieldType === 'date'}
		<input
			type="date"
			{placeholder}
			{disabled}
			value={value}
			oninput={handleInput}
			onblur={handleBlur}
		/>
	{:else if textFieldType === 'time'}
		<input
			type="time"
			{placeholder}
			{disabled}
			value={value}
			oninput={handleInput}
			onblur={handleBlur}
		/>
	{:else if textFieldType === 'obscured'}
		<input
			type="password"
			{placeholder}
			{disabled}
			value={value}
			oninput={handleInput}
			onblur={handleBlur}
		/>
	{:else}
		<input
			type="text"
			{placeholder}
			{disabled}
			value={value}
			oninput={handleInput}
			onblur={handleBlur}
		/>
	{/if}
</div>
{/if}

<style>
	.text-field-container {
		margin-bottom: 0;
	}

	.field-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.25rem;
	}

	.field-header label {
		margin-bottom: 0;
		font-weight: 600;
	}

	textarea {
		font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
		font-size: 0.9rem;
		line-height: 1.5;
		resize: vertical;
		min-height: 200px;
	}

	.markdown-preview {
		border: 1px solid var(--pico-form-element-border-color);
		border-radius: var(--pico-border-radius);
		padding: 1rem;
		min-height: 200px;
		background: var(--pico-form-element-background-color);
		line-height: 1.6;
		text-align: justify;
	}

	.markdown-preview.clickable {
		cursor: text;
	}

	.markdown-preview.clickable:hover {
		border-color: var(--pico-primary);
	}

	.markdown-preview.clickable:focus-visible {
		outline: 2px solid var(--pico-primary);
		outline-offset: 1px;
	}

	.markdown-preview :global(h1),
	.markdown-preview :global(h2),
	.markdown-preview :global(h3),
	.markdown-preview :global(h4) {
		margin-top: 1rem;
		margin-bottom: 0.5rem;
	}

	.markdown-preview :global(ul),
	.markdown-preview :global(ol) {
		padding-left: 1.5rem;
	}

	.markdown-preview :global(p) {
		margin-bottom: 0.5rem;
	}

	.markdown-preview :global(code) {
		background: var(--pico-code-background-color);
		padding: 0.125rem 0.25rem;
		border-radius: 3px;
	}

	/* ============== INLINE MODE ==============
	   Inline TextFields render as plain text that turns into an editable input
	   on click. Display + edit states share padding and border width so the
	   surrounding layout doesn't shift when toggling.
	   ========================================== */
	.inline-field {
		display: inline-flex;
		align-items: baseline;
		gap: 0.25rem;
		min-width: 0;
		max-width: 100%;
	}

	.inline-display,
	.inline-input {
		font: inherit;
		line-height: 1.3;
		padding: 0.05rem 0.3rem;
		border: 1px solid transparent;
		border-radius: 4px;
		margin: 0;
		min-width: 0;
		box-sizing: border-box;
		font-variant-numeric: inherit;
	}

	.inline-display {
		background: transparent;
		color: inherit;
		text-align: inherit;
		cursor: text;
		display: inline-block;
		max-width: 100%;
		min-width: 1.5ch;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		width: auto;
	}

	.inline-display:hover:not(:disabled) {
		background: color-mix(in srgb, var(--pico-primary) 7%, transparent);
		border-color: color-mix(in srgb, var(--pico-primary) 28%, transparent);
	}

	.inline-display:focus-visible {
		outline: 2px solid var(--pico-primary);
		outline-offset: 1px;
	}

	.inline-display:disabled {
		cursor: not-allowed;
		opacity: 0.7;
	}

	.inline-display.empty {
		color: var(--pico-muted-color);
		font-style: italic;
	}

	.inline-input {
		background: var(--pico-form-element-background-color);
		color: var(--pico-color);
		border-color: var(--pico-form-element-border-color);
		field-sizing: content;
		min-width: 3ch;
		max-width: 16ch;
		text-align: inherit;
	}

	.inline-input:focus {
		outline: none;
		border-color: var(--pico-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--pico-primary) 30%, transparent);
	}

	/* Hide native number spinners — they don't fit the inline aesthetic. */
	.inline-input::-webkit-inner-spin-button,
	.inline-input::-webkit-outer-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.inline-input[type='number'] {
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.inline-suffix {
		color: var(--pico-muted-color);
		flex-shrink: 0;
		white-space: nowrap;
	}
</style>
