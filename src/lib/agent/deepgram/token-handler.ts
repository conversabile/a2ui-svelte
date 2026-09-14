export interface MintDeepgramTokenOptions {
	/** Server-side Deepgram API key. Caller is responsible for selecting the right one (per-user vs. shared). */
	apiKey: string;
	/**
	 * Token TTL in seconds. Deepgram's default is 30 s — enough to establish
	 * the socket (auth happens only at the handshake); the session itself can
	 * outlive the token. Max 3600.
	 */
	ttlSeconds?: number;
	/** API base URL. Default `'https://api.deepgram.com'`. */
	baseUrl?: string;
}

/**
 * Mint a short-lived grant JWT for `DeepgramVoiceAgentModel`. Throws on
 * failure with a normalised Error — callers translate to HTTP responses.
 *
 * Usage in a SvelteKit POST handler:
 *
 *   import { mintDeepgramToken } from 'a2ui-svelte/agent/deepgram';
 *   export const POST = async ({ locals }) => {
 *     if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
 *     try {
 *       const token = await mintDeepgramToken({ apiKey: DEEPGRAM_API_KEY });
 *       return json({ token });
 *     } catch (e) {
 *       return json({ error: 'Mint failed' }, { status: 502 });
 *     }
 *   };
 */
export async function mintDeepgramToken(opts: MintDeepgramTokenOptions): Promise<string> {
	const baseUrl = opts.baseUrl ?? 'https://api.deepgram.com';
	const res = await fetch(`${baseUrl}/v1/auth/grant`, {
		method: 'POST',
		headers: {
			Authorization: `Token ${opts.apiKey}`,
			'Content-Type': 'application/json'
		},
		...(opts.ttlSeconds !== undefined
			? { body: JSON.stringify({ ttl_seconds: opts.ttlSeconds }) }
			: {})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Deepgram token grant failed (${res.status}): ${body.slice(0, 300)}`);
	}
	const json = (await res.json()) as { access_token?: string };
	if (!json.access_token) {
		throw new Error('Deepgram did not return an access token');
	}
	return json.access_token;
}
