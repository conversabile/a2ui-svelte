/**
 * Back-compat shim. The debug telemetry moved to the neutral agent layer
 * (`../agent/debug.svelte`) in WP2; this re-export preserves the historical
 * `a2ui-svelte/voice` import path (`VoiceShell`, `voice/index.ts`, and any
 * external consumer importing `./debug.svelte` keep working unchanged).
 */
export {
	VoiceDebugStats,
	AgentDebugStats,
	formatBytes,
	formatTokens,
	type VoiceDebugStatsOptions,
	type DebugPayloadStat,
	type DebugEvent,
	type DebugOutboundKind,
	type DebugInboundKind
} from '../agent/debug.svelte';
