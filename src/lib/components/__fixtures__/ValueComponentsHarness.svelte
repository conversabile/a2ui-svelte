<script lang="ts">
	import StaticSurface from '../../renderer/StaticSurface.svelte';
	import Checkbox from '../Checkbox.svelte';
	import Slider from '../Slider.svelte';
	import DateTimeInput from '../DateTimeInput.svelte';
	import MultipleChoice from '../MultipleChoice.svelte';
	import Tabs from '../Tabs.svelte';

	/**
	 * Every value-bearing catalog component mounted with **neither `id` nor
	 * `fieldName`** — so each one's data-model key is the auto-generated
	 * component id. An agent update on that id must report the same id back as
	 * `field`; anything else names a key that does not exist in the data model.
	 *
	 * `onReady` hands the test the resolved component ids, the surface data
	 * model, and live readers for the bound values.
	 */
	interface HarnessApi {
		ids: Record<string, string | undefined>;
		getDataModel: () => Record<string, unknown>;
		values: () => Record<string, unknown>;
	}

	let { onReady }: { onReady: (api: HarnessApi) => void } = $props();

	let checked = $state(false);
	let sliderValue = $state(0);
	let when = $state('');
	let selections = $state<string[]>([]);

	let surface = $state<{ getDataModel: () => Record<string, unknown> } | undefined>();
	let checkboxRef = $state<{ componentId: string | undefined } | undefined>();
	let sliderRef = $state<{ componentId: string | undefined } | undefined>();
	let dateRef = $state<{ componentId: string | undefined } | undefined>();
	let choiceRef = $state<{ componentId: string | undefined } | undefined>();
	let tabsRef = $state<{ componentId: string | undefined } | undefined>();

	$effect(() => {
		if (!surface || !checkboxRef || !sliderRef || !dateRef || !choiceRef || !tabsRef) return;
		const s = surface;
		onReady({
			ids: {
				checkbox: checkboxRef.componentId,
				slider: sliderRef.componentId,
				dateTime: dateRef.componentId,
				choice: choiceRef.componentId,
				tabs: tabsRef.componentId
			},
			getDataModel: () => s.getDataModel(),
			values: () => ({ checked, sliderValue, when, selections })
		});
	});
</script>

<StaticSurface bind:this={surface} surfaceId="value-components">
	{#snippet children()}
		<Checkbox bind:this={checkboxRef} label="Terms" bind:checked />
		<Slider bind:this={sliderRef} label="Portions" bind:value={sliderValue} />
		<DateTimeInput bind:this={dateRef} label="When" bind:value={when} />
		<MultipleChoice
			bind:this={choiceRef}
			label="Size"
			options={[
				{ label: 'Small', value: 'small' },
				{ label: 'Large', value: 'large' }
			]}
			bind:selections
		/>
		<Tabs
			bind:this={tabsRef}
			tabs={[
				{ key: 'one', title: 'One' },
				{ key: 'two', title: 'Two' }
			]}
		>
			{#snippet content(key)}
				<span>{key}</span>
			{/snippet}
		</Tabs>
	{/snippet}
</StaticSurface>
