<script lang="ts">
	import { A2UIRepresentation } from 'a2ui-svelte/authoring';
	import { MultipleChoice } from 'a2ui-svelte/components';

	interface Props {
		id?: string;
		label?: string;
		value?: number;
		onchange?: (value: number) => void;
	}

	let { id, label = 'Rating', value = $bindable(0), onchange }: Props = $props();

	let mcNode = $state<MultipleChoice>();
	let selections = $state<string[]>(value ? [String(value)] : []);

	const stars = [1, 2, 3, 4, 5];
	const options = stars.map((n) => ({ value: String(n), label: `${n} star${n > 1 ? 's' : ''}` }));

	// Single convergence point — reached by the agent (via the MultipleChoice
	// action handler) and by the user (via fire() below).
	function apply(n: number) {
		value = n;
		onchange?.(n);
	}

	// User clicks a star: update optimistically for instant feedback, then
	// route through fire() so the click runs the *same* action the agent uses.
	function pick(n: number) {
		value = n;
		mcNode?.fire(String(n));
	}
</script>

<!--
  Inside <A2UIRepresentation> the MultipleChoice registers with the surface
  (so the agent can target it) but renders nothing. The agent sees a plain
  5-option MultipleChoice; the user sees the custom star row below.
-->
<A2UIRepresentation>
	<MultipleChoice
		bind:this={mcNode}
		id="rating"
		fieldName="rating"
		{label}
		{options}
		bind:selections
		maxAllowedSelections={1}
		onchange={(sel) => apply(Number(sel[0]) || 0)}
	/>
</A2UIRepresentation>

<div class="star-rating" {id}>
	{#if label}<span class="label">{label}</span>{/if}
	<div class="stars" {...mcNode?.dataAttr} role="radiogroup" aria-label={label}>
		{#each stars as n}
			<button
				type="button"
				class="star"
				class:filled={n <= value}
				aria-label={`${n} star${n > 1 ? 's' : ''}`}
				aria-pressed={n <= value}
				onclick={() => pick(n)}
			>
				★
			</button>
		{/each}
	</div>
</div>

<style>
	.star-rating {
		padding: 1rem;
		border: 1px solid var(--a2ui-input-border);
		border-radius: var(--a2ui-card-radius);
		background: var(--a2ui-card-bg);
	}
	.label {
		display: block;
		margin-bottom: 0.4rem;
		font-weight: 600;
		font-size: 0.85rem;
	}
	.stars {
		display: flex;
		gap: 0.25rem;
	}
	.star {
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font-size: 2rem;
		line-height: 1;
		color: var(--a2ui-input-border);
		transition: color 0.1s ease;
	}
	.star.filled {
		color: #f5b301;
	}
</style>
