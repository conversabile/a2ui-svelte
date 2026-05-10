import { processMessage } from '../core/processor';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import { userActionBus, type UserAction } from '../core/registries/event-bus';
import type { VoiceTransport } from './transport';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';
import { buildSystemPrompt, type PromptInputs } from './prompt-builder';

export type VoiceMode = 'static' | 'dynamic' | 'both';
export type VoiceStatus = 'idle' | 'thinking' | 'error';

export interface VoiceAgentSurface {
	id: string;
	type: 'static' | 'dynamic';
	getJson(): unknown;
}

export interface VoiceAgentOptions {
	/** Provider-specific voice transport. */
	transport: VoiceTransport;
	/** Live source of currently-active surfaces. Called on every interval tick. */
	surfaces: () => VoiceAgentSurface[];
	/** Live source of page-specific context instructions. */
	contextInstructions: () => string;
	/** Base system prompt (the persona + style). */
	systemInstruction: string;
	/** Static / dynamic / both. Default 'static'. */
	mode?: VoiceMode;
	/** Override prompt assembly entirely. */
	buildPrompt?: (inputs: PromptInputs) => string;
	/** Optional voice name passed to the transport. */
	voice?: string;
	/** Auth token mint function — called once per `start()`. */
	mintToken: () => Promise<string>;
}

/**
 * Provider-agnostic voice agent. Owns the audio recorder + player, prompt
 * assembly (via prompt-builder), tool dispatch, surface-watch interval with
 * agent-modification cooldown, userActionBus subscription, and transcript
 * state. Does NOT own any UI — VoiceShell renders the default UI; consumers
 * can render their own bound to this class's reactive state.
 */
export class VoiceAgent {
	connected = $state(false);
	recording = $state(false);
	status = $state<VoiceStatus>('idle');
	transcript = $state<Array<{ role: 'user' | 'model'; text: string }>>([]);
	hasStarted = $state(false);
	configIssue = $state<string | null>(null);

	#opts: VoiceAgentOptions;
	#mode: VoiceMode;
	#recorder: AudioRecorder | null = null;
	#player: AudioPlayer | null = null;
	#unsubs: Array<() => void> = [];
	#surfaceInterval: ReturnType<typeof setInterval> | null = null;
	#lastAgentMutationAt = 0;
	#lastSurfaceSnapshot = '';
	#lastContextSnapshot = '';
	#lastSurfaceIds = '';
	#intentionalDisconnect = false;
	#currentModelText = '';
	#canAppendToUser = false;

	constructor(opts: VoiceAgentOptions) {
		this.#opts = opts;
		this.#mode = opts.mode ?? 'static';
	}

	async start(): Promise<void> {
		this.status = 'idle';
		this.configIssue = null;
		this.#intentionalDisconnect = false;

		let token: string;
		try {
			token = await this.#opts.mintToken();
		} catch (e) {
			this.configIssue = (e as Error).message ?? 'Failed to mint token';
			this.status = 'error';
			return;
		}

		const tools = this.#assembleToolDeclarations();
		const systemInstruction = this.#buildPrompt(tools);

		try {
			await this.#opts.transport.connect({
				token,
				systemInstruction,
				tools,
				voice: this.#opts.voice
			});
		} catch (e) {
			console.error('[VoiceAgent] Failed to connect transport:', e);
			this.status = 'error';
			return;
		}

		this.#unsubs.push(
			this.#opts.transport.on('tool-call', (p) => {
				void this.#handleToolCall(p.calls);
			}),
			this.#opts.transport.on('audio-out', (p) => {
				this.#player?.addToQueue(p.base64Pcm24k);
				this.#onModelActivity();
				this.#canAppendToUser = false;
			}),
			this.#opts.transport.on('transcript-out', (p) => this.#onTranscriptOut(p.text)),
			this.#opts.transport.on('transcript-in', (p) => this.#onTranscriptIn(p.text)),
			this.#opts.transport.on('interrupted', () => {
				this.#player?.stop();
				if (this.status !== 'error') this.status = 'thinking';
			}),
			this.#opts.transport.on('turn-complete', () => this.#onTurnComplete()),
			this.#opts.transport.on('error', (p) => {
				console.error('[VoiceAgent] Transport error:', p.message, p.cause);
				if (!this.#intentionalDisconnect) this.status = 'error';
				void this.stop();
			}),
			this.#opts.transport.on('close', (p) => {
				console.log('[VoiceAgent] Transport closed:', p.reason);
				if (!this.#intentionalDisconnect) this.status = 'error';
				void this.stop();
			})
		);

		this.#unsubs.push(userActionBus.subscribe((a) => this.#handleUserAction(a)));

		try {
			this.#recorder = new AudioRecorder();
			this.#player = new AudioPlayer(24000);
			this.#recorder.addEventListener('data', (e) => {
				const detail = (e as CustomEvent<string>).detail;
				if (this.connected) this.#opts.transport.sendAudioChunk(detail);
			});
			await this.#recorder.start();
		} catch (e) {
			console.error('[VoiceAgent] Failed to start recorder:', e);
			this.configIssue = (e as Error).message ?? 'Microphone unavailable';
			this.status = 'error';
			void this.stop();
			return;
		}

		this.connected = true;
		this.hasStarted = true;
		this.recording = true;
		this.#canAppendToUser = false;
		this.#startSurfaceWatch();
	}

	async stop(): Promise<void> {
		this.#stopSurfaceWatch();

		for (const u of this.#unsubs) {
			try {
				u();
			} catch {
				// best-effort
			}
		}
		this.#unsubs = [];

		try {
			this.#opts.transport.close();
		} catch {
			// best-effort
		}

		this.#recorder?.stop();
		this.#player?.stop();

		if (this.#currentModelText.trim()) {
			this.transcript = [
				...this.transcript,
				{ role: 'model', text: this.#currentModelText.trim() }
			];
			this.#currentModelText = '';
		}

		this.#recorder = null;
		this.#player = null;
		this.recording = false;
		this.connected = false;
		this.#canAppendToUser = false;
	}

	async toggle(): Promise<void> {
		if (this.connected) {
			this.#intentionalDisconnect = true;
			this.status = 'idle';
			await this.stop();
		} else {
			await this.start();
		}
	}

	sendTextMessage(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.status !== 'error') this.status = 'thinking';
		this.transcript = [...this.transcript, { role: 'user', text: trimmed }];
		this.#canAppendToUser = false;
		if (this.connected) {
			this.#opts.transport.sendText(trimmed);
		} else {
			console.warn('[VoiceAgent] Cannot send text message: not connected');
		}
	}

	async reset(): Promise<void> {
		if (this.connected) {
			this.#intentionalDisconnect = true;
			await this.stop();
		}
		this.status = 'idle';
		this.transcript = [];
		this.#currentModelText = '';
		this.#canAppendToUser = false;
		this.hasStarted = false;
		this.configIssue = null;
	}

	// ===== Internals =====

	#onModelActivity(): void {
		if (this.status === 'thinking') this.status = 'idle';
	}

	#onTranscriptOut(text: string): void {
		if (!text) return;
		this.#onModelActivity();
		this.#canAppendToUser = false;
		this.#currentModelText += text;
		const last = this.transcript.length - 1;
		if (last >= 0 && this.transcript[last].role === 'model') {
			this.transcript[last].text = this.#currentModelText;
		} else {
			this.transcript = [...this.transcript, { role: 'model', text: this.#currentModelText }];
		}
	}

	#onTranscriptIn(text: string): void {
		if (!text) return;
		if (this.status !== 'error') this.status = 'thinking';
		const last = this.transcript.length - 1;
		if (this.#canAppendToUser && last >= 0 && this.transcript[last].role === 'user') {
			this.transcript[last].text += text;
		} else {
			this.transcript = [...this.transcript, { role: 'user', text }];
			this.#canAppendToUser = true;
		}
	}

	#onTurnComplete(): void {
		if (this.#currentModelText.trim()) {
			const last = this.transcript.length - 1;
			if (last >= 0 && this.transcript[last].role === 'model') {
				this.transcript[last].text = this.#currentModelText;
			}
			this.#currentModelText = '';
			this.#canAppendToUser = false;
		}
		if (this.status === 'thinking') this.status = 'idle';
	}

	#assembleToolDeclarations(): Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}> {
		const declarations = toolRegistry.getDeclarations().slice();

		if (this.#mode === 'dynamic' || this.#mode === 'both') {
			declarations.unshift({
				name: 'dataModelUpdate',
				description:
					"Updates the data model of a dynamic surface (A2UI v0.8). Components bound via {path: '...'} automatically re-render when their target path changes. Prefer this over re-sending surfaceUpdate when only content changes.",
				parameters: {
					type: 'object',
					properties: {
						surfaceId: { type: 'string', description: 'Target dynamic surface ID' },
						path: {
							type: 'string',
							description:
								"Optional JSON-Pointer location to update (e.g. '/user' or '/'). If omitted entirely, contents REPLACES the entire data model for the surface — so pass '/' to merge at the root without clobbering siblings."
						},
						contents: {
							type: 'array',
							description:
								'Adjacency list of data entries. Each entry has a `key` and exactly one typed value: `valueString`, `valueNumber`, `valueBoolean`, or `valueMap` (recursive list of further entries).',
							items: {
								type: 'object',
								properties: {
									key: { type: 'string' },
									valueString: { type: 'string' },
									valueNumber: { type: 'number' },
									valueBoolean: { type: 'boolean' },
									valueMap: {
										type: 'array',
										description:
											'Nested adjacency list — builds a nested object under this key.',
										items: { type: 'object' }
									}
								},
								required: ['key']
							}
						}
					},
					required: ['surfaceId', 'contents']
				}
			});

			declarations.unshift({
				name: 'beginRendering',
				description: 'Sets the root component to be rendered on the dynamic surface.',
				parameters: {
					type: 'object',
					properties: {
						surfaceId: { type: 'string' },
						root: { type: 'string', description: 'ID of the root component' }
					},
					required: ['surfaceId', 'root']
				}
			});

			declarations.unshift({
				name: 'surfaceUpdate',
				description: 'Pushes UI component definitions to a dynamic surface.',
				parameters: {
					type: 'object',
					properties: {
						surfaceId: { type: 'string' },
						components: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string' },
									component: { type: 'object' }
								},
								required: ['id', 'component']
							}
						}
					},
					required: ['surfaceId', 'components']
				}
			});
		}

		return declarations;
	}

	#buildPrompt(
		tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
	): string {
		const surfaces = this.#opts.surfaces();
		const allowStatic = this.#mode === 'static' || this.#mode === 'both';
		const allowDynamic = this.#mode === 'dynamic' || this.#mode === 'both';

		const inputs: PromptInputs = {
			systemInstruction: this.#opts.systemInstruction,
			staticSurfaces: allowStatic
				? surfaces.filter((s) => s && s.type === 'static')
				: [],
			dynamicSurfaces: allowDynamic
				? surfaces.filter((s) => s && s.type === 'dynamic')
				: [],
			toolDeclarations: tools,
			contextInstructions: this.#opts.contextInstructions(),
			transcriptHistory: this.transcript,
			includeDynamicGuide: this.#mode === 'dynamic'
		};

		return (this.#opts.buildPrompt ?? buildSystemPrompt)(inputs);
	}

	async #handleToolCall(
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
	): Promise<void> {
		if (this.status !== 'error') this.status = 'thinking';
		this.#lastAgentMutationAt = Date.now();

		for (const call of calls) {
			let result: unknown;
			try {
				if (
					call.name === 'surfaceUpdate' ||
					call.name === 'beginRendering' ||
					call.name === 'dataModelUpdate'
				) {
					processMessage({ [call.name]: call.args } as never);
					result = { status: 'success' };
				} else {
					result = await toolRegistry.execute(call.name, call.args);
					// Update watchdog snapshots immediately so the surface-watch
					// interval doesn't fire a duplicate SURFACE_UPDATED event for
					// the agent's own change.
					this.#lastSurfaceSnapshot = this.#getSurfaceSnapshot();
					this.#lastContextSnapshot = this.#opts.contextInstructions();
					this.#lastSurfaceIds = this.#getSurfaceIds();
				}
			} catch (e) {
				result = { status: 'error', error: (e as Error).message ?? 'Unknown tool error' };
			}
			try {
				this.#opts.transport.sendToolResult(call.id, call.name, result);
			} catch (e) {
				console.error('[VoiceAgent] Failed to send tool result:', e);
				this.status = 'error';
			}
		}
	}

	#handleUserAction(action: UserAction): void {
		if (!this.connected) {
			console.warn('[VoiceAgent] Dropping userAction — no active session:', action);
			return;
		}
		if (this.status !== 'error') this.status = 'thinking';
		const payload = {
			userAction: {
				name: action.name,
				surfaceId: action.surfaceId,
				componentId: action.componentId,
				context: action.context
			}
		};
		const message = `<event>USER_ACTION</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
		try {
			this.#opts.transport.sendText(message);
		} catch (e) {
			console.warn('[VoiceAgent] Failed to forward userAction:', e);
		}
	}

	#getSurfaceSnapshot(): string {
		return JSON.stringify(
			this.#opts
				.surfaces()
				.filter((s) => s && s.type === 'static')
				.map((s) => s.getJson())
		);
	}

	#getSurfaceIds(): string {
		return this.#opts
			.surfaces()
			.filter((s) => s)
			.map((s) => s.id)
			.join(',');
	}

	#startSurfaceWatch(): void {
		this.#lastSurfaceSnapshot = this.#getSurfaceSnapshot();
		this.#lastContextSnapshot = this.#opts.contextInstructions();
		this.#lastSurfaceIds = this.#getSurfaceIds();

		this.#surfaceInterval = setInterval(() => {
			if (!this.connected) return;
			const surfaces = this.#opts.surfaces();
			if (surfaces.length === 0 || surfaces.every((s) => !s)) return;

			const cur = this.#getSurfaceSnapshot();
			const ctx = this.#opts.contextInstructions();
			const ids = this.#getSurfaceIds();

			if (cur !== this.#lastSurfaceSnapshot || ctx !== this.#lastContextSnapshot) {
				// Cooldown: ignore changes within 5s of an agent tool call —
				// EXCEPT when surface IDs change (page navigation), which is always notified.
				if (Date.now() - this.#lastAgentMutationAt > 5000 || ids !== this.#lastSurfaceIds) {
					this.#pushSurfaceUpdate(cur, ctx);
				}
				this.#lastSurfaceSnapshot = cur;
				this.#lastContextSnapshot = ctx;
				this.#lastSurfaceIds = ids;
			}
		}, 3000);
	}

	#stopSurfaceWatch(): void {
		if (this.#surfaceInterval) {
			clearInterval(this.#surfaceInterval);
			this.#surfaceInterval = null;
		}
	}

	#pushSurfaceUpdate(surfacesJson: string, context: string): void {
		const elementIds = actionRegistry.listActions().join(', ');
		const message = `<event>SURFACE_UPDATED</event>\n<updated_surfaces>\n${surfacesJson}\n</updated_surfaces>\n<updated_context>\n${context}\n</updated_context>\n<available_element_ids>\n${elementIds}\n</available_element_ids>`;
		try {
			this.#opts.transport.sendText(message);
		} catch (e) {
			console.warn('[VoiceAgent] Failed to push surface update:', e);
		}
	}
}
