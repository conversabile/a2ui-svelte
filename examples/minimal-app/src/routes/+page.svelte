<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { StaticSurface } from 'a2ui-svelte/renderer';
	import { Card, Column, TextField, Button, Text } from 'a2ui-svelte/components';
	import { session } from '$lib/session.svelte';

	let surfaceRef: StaticSurface | undefined = $state();
	let name = $state('');
	let saved = $state<string | null>(null);

	function place() {
		saved = name;
	}

	onMount(() => {
		// StaticSurface exposes { id, type, getJson } — the same shape VoiceAgent expects.
		if (surfaceRef) session.surfaces = [surfaceRef];
		session.contextInstructions =
			'The home page collects a name and lets the user click Save to commit it.';
	});

	onDestroy(() => {
		session.surfaces = [];
		session.contextInstructions = '';
	});
</script>

<h2>Static surface demo</h2>
<p>
	Try saying <em>"fill in the name with Ada and click save"</em>. The agent
	uses <code>update_text_field</code> + <code>click_button</code>.
</p>

<StaticSurface bind:this={surfaceRef} surfaceId="home">
	<Card>
		<Column>
			<Text id="hint" text="Enter a name and press Save." usageHint="body" />
			<TextField id="name" fieldName="name" label="Name" bind:value={name} />
			<Button
				id="save"
				primary
				label="Save"
				action={{ name: 'save' }}
				onclick={place}
			/>
		</Column>
	</Card>
</StaticSurface>

{#if saved}
	<p class="saved">Saved: <strong>{saved}</strong></p>
{/if}

<style>
	.saved {
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		background: var(--a2ui-card-bg);
		border-radius: var(--a2ui-card-radius);
	}
</style>
