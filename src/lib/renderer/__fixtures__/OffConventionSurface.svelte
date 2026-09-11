<script lang="ts">
	import StaticSurface from '../StaticSurface.svelte';
	import TextField from '../../components/TextField.svelte';

	/** Legal A2UI, off-convention ids — a warning, never a throw. */
	let value = $state('');
</script>

<StaticSurface surfaceId="off_convention">
	<TextField id="staff_notes" label="Notes" bind:value />
</StaticSurface>
