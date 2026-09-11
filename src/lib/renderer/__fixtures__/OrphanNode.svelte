<script lang="ts">
	import { getSurfaceContext } from '../../core/surface-registry';

	/**
	 * Registers straight against the surface registry with no parent and no
	 * referrer — the low-level mistake that puts a component in the agent's
	 * tree without putting it on the user's screen.
	 */
	getSurfaceContext()?.register('ghost-node', null, {
		Text: { text: { literalString: 'agent-only' } }
	});
</script>
