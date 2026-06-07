import {
	Agent,
	type AgentOptions,
	type AgentMode,
	type AgentStatus,
	type AgentSurface,
	type SurfaceWatchMode,
	type SurfaceWatchTuning
} from '../agent/agent.svelte';
import type { AgentTransportConnectOptions } from '../agent/transport';
import type { VoiceTransport, VoiceTransportConnectOptions } from './transport';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';

/**
 * Back-compat aliases for the neutral agent-layer types. WP2 moved the
 * orchestrator into `../agent/agent.svelte`; these keep the historical
 * `a2ui-svelte/voice` type names (`VoiceMode`, `VoiceStatus`,
 * `VoiceAgentSurface`) working unchanged.
 */
export type VoiceMode = AgentMode;
export type VoiceStatus = AgentStatus;
export type VoiceAgentSurface = AgentSurface;
export type { SurfaceWatchMode, SurfaceWatchTuning };

export interface VoiceAgentOptions extends AgentOptions {
	/** Provider-specific voice transport (narrows the neutral `AgentTransport`). */
	transport: VoiceTransport;
	/** Optional voice name passed to the transport. */
	voice?: string;
}

/**
 * Voice specialisation of {@link Agent}. Adds the streaming-audio surface a live
 * voice API needs and nothing else: the mic recorder + speaker player, the
 * `muted` toggle, and the `audio-out` / `interrupted` events. Everything
 * channel-neutral (prompt assembly, tool dispatch, surface-sync, user-actions,
 * transcript, debug, status watchdog) lives in the base.
 *
 * Pair with a {@link VoiceTransport} (e.g. `GeminiTransport`). Does NOT own any
 * UI — `VoiceShell` renders the default UI; consumers can render their own bound
 * to this class's reactive state.
 */
export class VoiceAgent extends Agent {
	recording = $state(false);
	/**
	 * Mic muted while the session stays open. When `true`, captured audio chunks
	 * are dropped instead of sent to the transport — the live connection,
	 * playback, and surface-sync all keep running. Lets the user silence a noisy
	 * environment so trailing background noise isn't heard as a barge-in that
	 * cuts the agent off mid-answer. See `toggleMute()`.
	 */
	muted = $state(false);

	#voice?: string;
	#recorder: AudioRecorder | null = null;
	#player: AudioPlayer | null = null;

	constructor(opts: VoiceAgentOptions) {
		super(opts);
		this.#voice = opts.voice;
	}

	/**
	 * Mute / unmute the microphone **without** tearing down the session. While
	 * muted, captured audio chunks are dropped instead of sent, so the model
	 * hears silence; the live connection, playback, and surface-sync keep
	 * running. The use case is noisy environments — once the user has spoken,
	 * trailing background noise would otherwise be heard as a barge-in and cut
	 * the agent off mid-answer; muting prevents that. Idempotent w.r.t. the
	 * connection: muting/unmuting never connects or disconnects.
	 */
	toggleMute(): void {
		this.muted = !this.muted;
	}

	/** Pass the voice/TTS name through on connect. */
	protected override augmentConnectOptions(
		opts: AgentTransportConnectOptions
	): VoiceTransportConnectOptions {
		return { ...opts, voice: this.#voice };
	}

	/** Wire the audio-only transport events the neutral base doesn't know about. */
	protected override wireExtraTransportEvents(): void {
		const transport = this.transport as VoiceTransport;
		this.pushUnsub(
			transport.on('audio-out', (p) => {
				// Model is producing a turn — gate sync delivery so we never
				// interrupt the answer in flight.
				this.modelTurnActive = true;
				this.recordInboundAudio(p.base64Pcm24k);
				this.#player?.addToQueue(p.base64Pcm24k);
				this.onModelActivity();
				this.canAppendToUser = false;
			})
		);
		this.pushUnsub(
			transport.on('interrupted', () => {
				// Generation was cut off — the model is idle again.
				this.modelTurnActive = false;
				this.#player?.stop();
				if (this.status !== 'error') this.setStatus('thinking');
			})
		);
	}

	/** Spin up the mic recorder + speaker player. Throws if the mic is unavailable. */
	protected override async startInput(): Promise<void> {
		// A fresh session always starts listening — mute is a per-session state.
		this.muted = false;
		const transport = this.transport as VoiceTransport;
		this.#recorder = new AudioRecorder();
		this.#player = new AudioPlayer(24000);
		this.#recorder.addEventListener('data', (e) => {
			const detail = (e as CustomEvent<string>).detail;
			// Drop captured audio while muted — the recorder keeps running (so
			// unmute resumes instantly without re-prompting for mic access), the
			// chunks just never reach the transport.
			if (this.connected && !this.muted) {
				transport.sendAudioChunk(detail);
				this.rec('audio-out', detail);
			}
		});
		await this.#recorder.start();
		this.recording = true;
	}

	/** Tear down the recorder + player. */
	protected override stopInput(): void {
		this.#recorder?.stop();
		this.#player?.stop();
		this.#recorder = null;
		this.#player = null;
		this.recording = false;
	}
}
