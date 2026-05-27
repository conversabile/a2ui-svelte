<script lang="ts">
	interface Props {
		label?: string;
	}

	let { label = '' }: Props = $props();
</script>

<span data-fixture="my-other-tag">other:{label}</span>
