<script lang="ts">
	import A2UIRepresentation from '../A2UIRepresentation.svelte';
	import TextField from '../../components/TextField.svelte';
	import Button from '../../components/Button.svelte';

	let value = $state('');
	let inputNode = $state<{
		componentId: string | undefined;
		dataAttr: Record<string, string>;
		fire: (value?: string) => Promise<unknown>;
	} | undefined>();
	let saveNode = $state<{
		componentId: string | undefined;
		dataAttr: Record<string, string>;
		fire: (value?: string) => Promise<unknown>;
	} | undefined>();

	function onSave() {
		// no-op stub for the test
	}
</script>

<A2UIRepresentation>
	<TextField
		bind:this={inputNode}
		id="save-input"
		fieldName="save-input"
		bind:value
		label="Name"
	/>
	<Button bind:this={saveNode} id="save-action" label="Save" action={{ name: 'save-action' }} onclick={onSave} />
</A2UIRepresentation>

<div class="bespoke-save">
	<input bind:value {...inputNode?.dataAttr} />
	<button {...saveNode?.dataAttr} onclick={() => saveNode?.fire()}>Save</button>
</div>
