<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { StaticSurface } from 'a2ui-svelte/renderer';
	import { Card, Column, Text } from 'a2ui-svelte/components';
	import StarRating from '$lib/StarRating.svelte';
	import { session } from '$lib/session.svelte';

	let surfaceRef: StaticSurface | undefined = $state();
	let rating = $state(0);
	let log = $state<string[]>([]);

	function onChange(value: number) {
		log = [...log, `Rated ${value}/5`];
	}

	onMount(() => {
		if (surfaceRef) session.surfaces = [surfaceRef];
		session.contextInstructions =
			'The custom-elements page shows a star-rating widget. To the agent it is a ' +
			'MultipleChoice (id "rating") with five options "1 star" … "5 stars". ' +
			'To set a rating, call update_text_field on "rating" with the option value ' +
			'(e.g. "4"). The user sees five clickable stars instead.';
	});

	onDestroy(() => {
		session.surfaces = [];
		session.contextInstructions = '';
	});
</script>

<h2>Custom elements</h2>
<p>
	A2UI ships 16 standard components, but real apps need widgets the catalog
	doesn't have — star ratings, combo boxes, file pickers. There are two ways
	to add your own:
</p>
<ul class="ways">
	<li>
		<strong>Composite</strong> — render bespoke HTML to the user, but wrap a
		small tree of standard components in <code>&lt;A2UIRepresentation&gt;</code>
		so the agent still sees a familiar, spec-compliant surface. Best when the
		<em>look</em> is custom but the interaction maps onto existing components.
	</li>
	<li>
		<strong>New catalog component</strong> — author a brand-new spec component
		so the agent can also render it on a dynamic surface. More work; needed
		only when the agent itself must place the component. See the
		<code>build-custom-component</code> skill.
	</li>
</ul>
<p>
	The widget below is a <strong>composite</strong>. The agent sees a plain
	<code>MultipleChoice</code> with five options; you see five clickable stars.
	A click and a tool call both land in the same handler. Try saying
	<em>"give it four stars"</em>.
</p>

<StaticSurface bind:this={surfaceRef} surfaceId="custom-elements">
	<Card>
		<Column>
			<Text id="hint" text="Rate this demo:" usageHint="body" />
			<StarRating id="demo-rating" label="Your rating" bind:value={rating} onchange={onChange} />
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
	.ways {
		font-size: 0.9rem;
		padding-left: 1.2rem;
	}
	.ways li {
		margin-bottom: 0.5rem;
	}
	.log {
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		background: var(--a2ui-card-bg);
		border-radius: var(--a2ui-card-radius);
	}
</style>
