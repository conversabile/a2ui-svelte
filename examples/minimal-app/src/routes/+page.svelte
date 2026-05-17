<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { StaticSurface } from 'a2ui-svelte/renderer';
	import {
		Card,
		Column,
		Row,
		List,
		Text,
		Image,
		Icon,
		Divider,
		Button,
		TextField,
		Checkbox,
		Slider,
		DateTimeInput,
		MultipleChoice,
		Modal,
		Tabs
	} from 'a2ui-svelte/components';
	import { session } from '$lib/session.svelte';

	let surfaceRef: StaticSurface | undefined = $state();

	// Input states
	let name = $state('');
	let budget = $state('');
	let newsletter = $state(false);
	let rating = $state(7);
	let meetingDate = $state('');
	let role = $state<string[]>([]);
	let modalOpen = $state(false);

	// Activity log
	let log = $state<string[]>([]);
	function addLog(msg: string) {
		log = [msg, ...log.slice(0, 4)];
	}

	const tabs = [
		{ key: 'inputs', title: 'Inputs' },
		{ key: 'display', title: 'Display' },
		{ key: 'layout', title: 'Layout' }
	];

	onMount(() => {
		if (surfaceRef) session.surfaces = [surfaceRef];
		session.contextInstructions =
			'Static surface showing all 16 A2UI v0.8 components. ' +
			'Tabs id="demo-tabs" has three panels titled "Inputs", "Display", and "Layout". ' +
			'To switch tabs, call update_text_field on element_id "demo-tabs" with the tab title as the value. ' +
			'The inputs tab has text fields, checkbox, slider, date, and multiple-choice. ' +
			'Update the slider (id "rating-slider") and date (id "meeting-date") with update_text_field too. ' +
			'Click "Submit" to log the current values, or "Open Info" to open the modal.';
	});

	onDestroy(() => {
		session.surfaces = [];
		session.contextInstructions = '';
	});
</script>

<h2>Static surface — all 16 A2UI v0.8 components</h2>
<p>
	A <strong>static surface</strong> is UI that <em>you</em> lay out by hand in
	Svelte, exactly like a normal page. A2UI just makes that markup legible to
	the agent: every component exposes itself as JSON with a stable ID, so the
	agent can read and operate the same controls you see. The layout never
	changes at runtime — only the values do.
</p>
<p>
	Every standard catalog component appears in the surface below, authored
	natively as Svelte markup. Try saying
	<em>"set name to Alice, rating to 9, and click Submit"</em>.
</p>

<StaticSurface bind:this={surfaceRef} surfaceId="static-surface">
	<Card>
		<Column>
			<!-- Header row: Icon + Text (h2) -->
			<Row>
				<Icon id="header-icon" name="settings" accessibility={{ label: 'Settings' }} />
				<Text id="page-title" text="Component Showcase" usageHint="h2" />
			</Row>

			<Divider id="header-divider" />

			<Text
				id="page-description"
				text="This surface exercises all 16 standard components. Switch tabs to explore."
				usageHint="body"
			/>

			<!-- Tabs: three panels with all input and display components -->
			<Tabs id="demo-tabs" {tabs}>
				{#snippet content(tabKey: string)}
					{#if tabKey === 'inputs'}
						<Column>
							<TextField
								id="name-field"
								fieldName="name"
								label="Full name"
								textFieldType="shortText"
								bind:value={name}
							/>
							<TextField
								id="budget-field"
								fieldName="budget"
								label="Budget"
								textFieldType="number"
								bind:value={budget}
							/>
							<Checkbox
								id="newsletter-check"
								fieldName="newsletter"
								label="Subscribe to newsletter"
								bind:checked={newsletter}
								onchange={(v) => addLog(`Newsletter: ${v}`)}
							/>
							<Slider
								id="rating-slider"
								fieldName="rating"
								label="Rating"
								bind:value={rating}
								minValue={0}
								maxValue={10}
								onchange={(v) => addLog(`Rating: ${v}`)}
							/>
							<DateTimeInput
								id="meeting-date"
								fieldName="meetingDate"
								label="Meeting date"
								enableDate={true}
								enableTime={false}
								bind:value={meetingDate}
							/>
							<MultipleChoice
								id="role-choice"
								fieldName="role"
								label="Role"
								options={[
									{ label: 'Designer', value: 'designer' },
									{ label: 'Engineer', value: 'engineer' },
									{ label: 'Manager', value: 'manager' }
								]}
								bind:selections={role}
								maxAllowedSelections={1}
								onchange={(v) => addLog(`Role: ${v.join(', ')}`)}
							/>
						</Column>
					{:else if tabKey === 'display'}
						<Column>
							<Image
								id="demo-image"
								url="https://picsum.photos/seed/a2ui/400/120"
								fit="cover"
								usageHint="hero"
								accessibility={{ label: 'Placeholder hero image' }}
							/>
							<Divider id="display-divider" />
							<Row>
								<Icon id="icon-star" name="star" accessibility={{ label: 'Star' }} />
								<Icon id="icon-heart" name="heart" accessibility={{ label: 'Heart' }} />
								<Icon id="icon-check" name="check" accessibility={{ label: 'Check' }} />
								<Icon id="icon-info" name="info" accessibility={{ label: 'Info' }} />
							</Row>
							<Text id="icon-caption" text="Built-in Lucide icon subset" usageHint="caption" />
							<Divider id="display-divider-2" />
							<Text id="text-h3" text="Section heading (h3)" usageHint="h3" />
							<Text id="text-body" text="Body text with more detail about this component." usageHint="body" />
							<Text id="text-caption" text="Caption — small supplementary note." usageHint="caption" />
						</Column>
					{:else if tabKey === 'layout'}
						<Column>
							<Text id="layout-intro" text="Row with spaceBetween distribution:" usageHint="body" />
							<Row distribution="spaceBetween" alignment="center">
								<Text id="layout-left" text="Left" weight={1} />
								<Text id="layout-center" text="Center" weight={1} />
								<Text id="layout-right" text="Right" weight={1} />
							</Row>
							<Divider id="layout-divider" />
							<Text id="list-intro" text="Vertical List:" usageHint="body" />
							<List id="feature-list" direction="vertical">
								<Row>
									<Icon id="li1-icon" name="check" />
									<Text id="li1-text" text="100% spec-compliant JSON output" usageHint="body" />
								</Row>
								<Row>
									<Icon id="li2-icon" name="check" />
									<Text id="li2-text" text="Dual human + agent interaction" usageHint="body" />
								</Row>
								<Row>
									<Icon id="li3-icon" name="check" />
									<Text id="li3-text" text="Dark-mode and theming support" usageHint="body" />
								</Row>
							</List>
						</Column>
					{/if}
				{/snippet}
			</Tabs>

			<Divider id="actions-divider" />

			<!-- Action row: Modal trigger + Submit button -->
			<Row>
				<Modal id="info-modal" bind:open={modalOpen}>
					{#snippet entryPoint()}
						<Button
							id="open-info"
							label="Open Info"
							action={{ name: 'open-info' }}
							onclick={() => {
								modalOpen = true;
							}}
						/>
					{/snippet}
					{#snippet content()}
						<Column>
							<Text id="modal-title" text="About this demo" usageHint="h3" />
							<Text
								id="modal-body"
								text="This modal is a standard A2UI Modal component. The agent can click 'Open Info' to open it and 'Got it' to confirm."
								usageHint="body"
							/>
							<Button
								id="modal-confirm"
								label="Got it"
								primary
								action={{ name: 'modal-confirm' }}
								onclick={() => {
									modalOpen = false;
									addLog('Modal confirmed');
								}}
							/>
						</Column>
					{/snippet}
				</Modal>

				<Button
					id="submit"
					primary
					label="Submit"
					action={{ name: 'submit' }}
					onclick={() =>
						addLog(
							`Submitted — name="${name}" budget="${budget}" rating=${rating} role=${role.join(',')}`
						)}
				/>
			</Row>
		</Column>
	</Card>
</StaticSurface>

{#if log.length > 0}
	<section class="log">
		<h3>Activity log</h3>
		<ul>
			{#each log as entry}
				<li>{entry}</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.log {
		margin-top: 1rem;
	}
	.log h3 {
		font-size: 0.9rem;
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.log ul {
		margin: 0;
		padding-left: 1.2rem;
		font-size: 0.85rem;
		color: var(--a2ui-muted-color, #888);
	}
</style>
