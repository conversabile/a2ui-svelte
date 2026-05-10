<script lang="ts">
	import { A2UIRepresentation } from 'a2ui-svelte/authoring';
	import { Column, TextField, Button } from 'a2ui-svelte/components';

	interface Props {
		id?: string;
		label?: string;
		onSave?: (value: string) => void;
	}

	let { id, label = 'Value', onSave }: Props = $props();

	let value = $state('');
	let inputNode = $state<TextField>();
	let saveNode = $state<Button>();

	function commit() {
		onSave?.(value);
	}
</script>

<A2UIRepresentation>
	<Column>
		<TextField
			bind:this={inputNode}
			id="input"
			fieldName="value"
			{label}
			bind:value
			textFieldType="shortText"
		/>
		<Button
			bind:this={saveNode}
			id="save"
			primary
			label="Save"
			action={{ name: 'save' }}
			onclick={commit}
		/>
	</Column>
</A2UIRepresentation>

<div class="save-textfield" {id}>
	{#if label}<label for="{inputNode?.componentId}-input">{label}</label>{/if}
	<div class="row">
		<input
			id="{inputNode?.componentId}-input"
			type="text"
			placeholder="Type something..."
			bind:value
			{...inputNode?.dataAttr}
		/>
		<button class="save" {...saveNode?.dataAttr} onclick={() => saveNode?.fire()}>
			Save
		</button>
	</div>
</div>

<style>
	.save-textfield {
		padding: 1rem;
		border: 1px solid var(--a2ui-input-border);
		border-radius: var(--a2ui-card-radius);
		background: var(--a2ui-card-bg);
	}
	.save-textfield label {
		display: block;
		margin-bottom: 0.4rem;
		font-weight: 600;
		font-size: 0.85rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
	}
	.row input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		background: var(--a2ui-input-bg);
		color: var(--a2ui-input-fg);
		border: 1px solid var(--a2ui-input-border);
		border-radius: var(--a2ui-border-radius);
	}
	.save {
		padding: 0.5rem 1rem;
		background: var(--a2ui-button-primary-bg);
		color: var(--a2ui-button-primary-fg);
		border: none;
		border-radius: var(--a2ui-border-radius);
		cursor: pointer;
		font-weight: 600;
	}
</style>
