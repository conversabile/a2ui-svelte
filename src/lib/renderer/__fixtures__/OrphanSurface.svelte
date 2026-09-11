<script lang="ts">
	import StaticSurface from '../StaticSurface.svelte';
	import Text from '../../components/Text.svelte';
	import OrphanNode from './OrphanNode.svelte';
</script>

<!--
	A surface with a component in the tree that nothing on screen points at —
	the agent-sees-it-but-the-user-doesn't half of Rule 4. Mounting it must
	fail loudly.
-->
<StaticSurface surfaceId="orphan-surface">
	<Text id="visible-note" text="on screen" />
	<OrphanNode />
</StaticSurface>
