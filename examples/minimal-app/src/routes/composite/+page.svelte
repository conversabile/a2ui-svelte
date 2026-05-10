<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { StaticSurface } from 'a2ui-svelte/renderer';
	import { Card, Column, Text } from 'a2ui-svelte/components';
	import SaveTextField from '$lib/SaveTextField.svelte';
	import { session } from '$lib/session.svelte';

	let surfaceRef: StaticSurface | undefined = $state();
	let log = $state<string[]>([]);

	function onSave(value: string) {
		log = [...log, `Saved: ${value}`];
	}

	onMount(() => {
		if (surfaceRef) session.surfaces = [surfaceRef];
		session.contextInstructions =
			'The composite page demonstrates a SaveTextField. To the agent it looks like a Column containing a TextField (id "input") and a Button (id "save"). The user sees a single bespoke widget.';
	});

	onDestroy(() => {
		session.surfaces = [];
		session.contextInstructions = '';
	});
</script>

<h2>Composite component demo</h2>
<p>
	The widget below uses <code>&lt;A2UIRepresentation&gt;</code> internally:
	the agent sees a clean <code>Column → [TextField, Button]</code>; you see
	the bespoke styled row. Try saying <em>"type 'hello' and click save"</em>.
</p>

<StaticSurface bind:this={surfaceRef} surfaceId="composite">
	<Card>
		<Column>
			<Text id="hint" text="Composite SaveTextField below:" usageHint="body" />
			<SaveTextField id="save-text-field" label="Greeting" {onSave} />
		</Column>
	</Card>
</StaticSurface>

{#if log.length > 0}
	<ul class="log">
		{#each log as entry}
			<li>{entry}</li>
		{/each}
	</ul>
{/if}

<style>
	.log {
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		background: var(--a2ui-card-bg);
		border-radius: var(--a2ui-card-radius);
	}
</style>
