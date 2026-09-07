<script lang="ts">
	import StaticSurface from '../../src/lib/renderer/StaticSurface.svelte';
	import Column from '../../src/lib/components/Column.svelte';
	import Row from '../../src/lib/components/Row.svelte';
	import Text from '../../src/lib/components/Text.svelte';
	import TextField from '../../src/lib/components/TextField.svelte';
	import Button from '../../src/lib/components/Button.svelte';
	import Divider from '../../src/lib/components/Divider.svelte';

	/**
	 * Dense, realistic eval fixture: a team shift planner. One roster row per
	 * staff member with seven TextField day cells (`shift-<name>-<day>`), an
	 * add-staff form whose submission APPENDS a row (a structural change the
	 * model can only learn from a surface echo / sync), and a save button.
	 *
	 * `staffCount` scales the surface for verbosity measurements: the first six
	 * members are a fixed seed (so eval questions have stable answers); higher
	 * counts append generated members.
	 */
	interface Props {
		surfaceId?: string;
		staffCount?: number;
	}

	let { surfaceId = 'shift-planner', staffCount = 6 }: Props = $props();

	const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
	const DAY_LABELS: Record<string, string> = {
		mon: 'Monday',
		tue: 'Tuesday',
		wed: 'Wednesday',
		thu: 'Thursday',
		fri: 'Friday',
		sat: 'Saturday',
		sun: 'Sunday'
	};

	interface Staff {
		slug: string;
		name: string;
		role: string;
		shifts: Record<string, string>;
	}

	function withAllDays(partial: Record<string, string>): Record<string, string> {
		const shifts: Record<string, string> = {};
		for (const d of DAYS) shifts[d] = partial[d] ?? '';
		return shifts;
	}

	function makeStaff(name: string, role: string, shifts: Record<string, string> = {}): Staff {
		return { slug: name.toLowerCase(), name, role, shifts: withAllDays(shifts) };
	}

	const SEED: Staff[] = [
		makeStaff('Anna', 'Cook', { mon: '09:00-17:00', tue: '09:00-17:00' }),
		makeStaff('Carla', 'Waiter', { mon: '12:00-20:00', fri: 'Evening' }),
		makeStaff('Marco', 'Cook', { wed: 'Morning' }),
		makeStaff('Lucia', 'Waiter'),
		makeStaff('Paolo', 'Barista', { sat: 'Morning', sun: 'Morning' }),
		makeStaff('Sara', 'Manager', { mon: '08:00-16:00', tue: '08:00-16:00', wed: '08:00-16:00' })
	];

	function seedStaff(count: number): Staff[] {
		const out = SEED.slice(0, Math.min(count, SEED.length));
		for (let i = SEED.length; i < count; i++) {
			out.push(makeStaff(`Staff${i + 1}`, i % 2 === 0 ? 'Cook' : 'Waiter'));
		}
		return out;
	}

	let staff = $state<Staff[]>(seedStaff(staffCount));
	let newName = $state('');
	let newRole = $state('');
	let lastSavedAt = $state('');

	function contextText(): string {
		return (
			'Team Shift Planner. The roster has one row per staff member; each day cell is a ' +
			'TextField with id "shift-<name lowercase>-<day>" (days: mon, tue, wed, thu, fri, sat, sun). ' +
			'Fill cells with a time range like "09:00-17:00" or a shift name like "Morning" / "Evening"; ' +
			'an empty cell means a day off. To add a staff member, fill "add-staff-name" and ' +
			'"add-staff-role", then click "add-staff-btn" — the form clears and a new roster row appears. ' +
			'Click "save-week-btn" to persist the week.' +
			(lastSavedAt ? ` Week last saved at ${lastSavedAt}.` : ' The week has not been saved yet.')
		);
	}

	function addStaff() {
		const name = newName.trim();
		if (!name) return;
		staff = [...staff, makeStaff(name, newRole.trim() || 'Staff')];
		newName = '';
		newRole = '';
	}

	// ── Harness accessors (the eval drives + asserts through these) ──
	// The surface itself comes from the library's index — `surface('shift-planner')`.
	export const contextInstructions = () => contextText();
	export const getStaff = () =>
		staff.map((m) => ({ name: m.name, role: m.role, shifts: { ...m.shifts } }));
</script>

<StaticSurface {surfaceId}>
	<Column>
		<Text id="planner-title" text="Team Shift Planner" usageHint="h2" />
		<Text
			id="planner-help"
			text="Weekly shift roster. One row per staff member; one cell per day."
			usageHint="caption"
		/>
		<Divider id="planner-divider" />

		{#each staff as member (member.slug)}
			<Row>
				<Text id={`name-${member.slug}`} text={member.name} usageHint="body" />
				<Text id={`role-${member.slug}`} text={member.role} usageHint="caption" />
				{#each DAYS as day (day)}
					<TextField
						id={`shift-${member.slug}-${day}`}
						label={`${member.name} ${DAY_LABELS[day]}`}
						bind:value={member.shifts[day]}
					/>
				{/each}
			</Row>
		{/each}

		<Divider id="form-divider" />
		<Text id="add-staff-title" text="Add staff member" usageHint="h3" />
		<Row>
			<TextField id="add-staff-name" label="Name" bind:value={newName} />
			<TextField id="add-staff-role" label="Role" bind:value={newRole} />
			<Button id="add-staff-btn" label="Add staff" onclick={addStaff} />
		</Row>

		<Divider id="actions-divider" />
		<Button
			id="save-week-btn"
			primary
			label="Save week"
			onclick={() => {
				lastSavedAt = new Date().toISOString();
			}}
		/>
	</Column>
</StaticSurface>
