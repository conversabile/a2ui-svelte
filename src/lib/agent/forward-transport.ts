import type { AgentTransport, TransportCapabilities } from './transport';

/** An {@link AgentTransport} wrapper, plus the teardown for what it subscribed. */
export interface ForwardedTransport extends AgentTransport {
	/**
	 * Drop every subscription opened through this wrapper's `on()`. Does not
	 * close the inner transport — the owner of the inner still calls `close()`.
	 */
	dispose(): void;
}

/**
 * Wrap a transport, forwarding the whole {@link AgentTransport} contract to it
 * and replacing only what `overrides` names.
 *
 * A `Proxy`, not a hand-written class, for one reason: **optionality is
 * preserved and the contract cannot drift**. `Agent` and `<AgentShell>`
 * feature-detect the optional members (`sendContextUpdate`, `sendUserAction`,
 * `sendAudioChunk`), so a member absent on `inner` must stay absent on the
 * wrapper (`'sendAudioChunk' in wrapped` tracks `inner`) — and a member added to
 * the contract tomorrow forwards without anyone editing this file. Getters read
 * through live, so `capabilities` is never a stale snapshot.
 *
 * An override whose value is `undefined` **hides** that member: the wrapper
 * reports it absent even though `inner` implements it.
 *
 * Internal on purpose — export it from `./agent` the day a second wrapper needs
 * it (Rule 8: adding an export later is cheap, removing one is breaking).
 */
export function forwardTransport(
	inner: AgentTransport,
	overrides: Partial<AgentTransport> = {}
): ForwardedTransport {
	const subscriptions = new Set<() => void>();
	// Keyed by the unbound method, so a re-assigned member never serves a stale bind.
	const boundMethods = new WeakMap<object, unknown>();

	const on: AgentTransport['on'] = (event, handler) => {
		const off = inner.on(event, handler);
		const unsubscribe = () => {
			if (subscriptions.delete(unsubscribe)) off();
		};
		subscriptions.add(unsubscribe);
		return unsubscribe;
	};

	const dispose = () => {
		for (const unsubscribe of [...subscriptions]) unsubscribe();
	};

	const overridden = (prop: PropertyKey) => Object.prototype.hasOwnProperty.call(overrides, prop);
	const overrideOf = (prop: PropertyKey) => (overrides as Record<PropertyKey, unknown>)[prop];

	return new Proxy(inner, {
		get(target, prop) {
			if (prop === 'on') return on;
			if (prop === 'dispose') return dispose;
			if (overridden(prop)) return overrideOf(prop);
			// Bind to the inner: its methods read private fields, which throw on a Proxy `this`.
			const value = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			let bound = boundMethods.get(value);
			if (!bound) boundMethods.set(value, (bound = value.bind(target)));
			return bound;
		},
		has(target, prop) {
			if (prop === 'on' || prop === 'dispose') return true;
			if (overridden(prop)) return overrideOf(prop) !== undefined;
			return Reflect.has(target, prop);
		}
	}) as ForwardedTransport;
}

/**
 * Mask a transport's audio modality: `'audio'` stripped from
 * `capabilities.input`/`output` and `sendAudioChunk` hidden, everything else
 * forwarded untouched. The `Agent` — which adapts to capabilities, never to a
 * transport's identity — then runs it text-in/text-out and starts no mic
 * recorder or speaker player.
 *
 * For evals and any headless deployment (node/jsdom have no audio devices).
 * **The model still generates audio, so the token bill is unchanged — exactly
 * the production load.** Only the frames are dropped; the output transcription
 * carries the text.
 */
export function withoutAudio(transport: AgentTransport): ForwardedTransport {
	return forwardTransport(transport, {
		get capabilities(): TransportCapabilities {
			const caps = transport.capabilities;
			return {
				...caps,
				input: caps.input.filter((m) => m !== 'audio'),
				output: caps.output.filter((m) => m !== 'audio')
			};
		},
		sendAudioChunk: undefined
	});
}
