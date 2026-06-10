<script lang="ts">
	import Button from '../../components/Button.svelte';
	import TextField from '../../components/TextField.svelte';
	import Text from '../../components/Text.svelte';

	// Fixture for the 'diff' tool-result mode: one value-bearing field (a
	// data-model-only change when updated), one button that ADDS a component
	// (a structural change), and one that resets the field as a side effect
	// (a data-model change the agent didn't write itself).
	let name = $state('');
	let rows = $state<string[]>([]);
</script>

<TextField id="name-field" fieldName="name" label="Name" bind:value={name} />
<Button
	id="add-row"
	label="Add row"
	action={{ name: 'add-row' }}
	onclick={() => {
		rows = [...rows, `Row ${rows.length + 1}`];
	}}
/>
<Button
	id="reset-form"
	label="Reset"
	action={{ name: 'reset-form' }}
	onclick={() => {
		name = '';
	}}
/>
{#each rows as row, i (i)}
	<Text id={`row-${i + 1}`} text={row} />
{/each}
