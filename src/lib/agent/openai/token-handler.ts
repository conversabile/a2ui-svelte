export interface MintOpenAIRealtimeSecretOptions {
	/** Server-side OpenAI API key. Caller is responsible for selecting the right one (per-user vs. shared). */
	apiKey: string;
	/** Realtime model the secret is scoped to. Default `'gpt-realtime-2'` (keep in sync with `OpenAIRealtimeModel`). */
	model?: string;
	/** Secret expiry in seconds from creation. Default 600 (10 minutes). */
	expiresInSeconds?: number;
	/**
	 * Extra `session` fields to bake into the secret server-side (voice,
	 * instructions, turn detection…). `OpenAIRealtimeModel` still sends its own
	 * `session.update` on connect, so this is only needed for fields you want
	 * enforced server-side.
	 */
	session?: Record<string, unknown>;
	/** API base URL. Default `'https://api.openai.com/v1'`. */
	baseUrl?: string;
}

/**
 * Mint an ephemeral Realtime client secret (`ek_…`) for
 * `OpenAIRealtimeModel`. Throws on failure with a normalised Error —
 * callers translate to HTTP responses.
 *
 * Usage in a SvelteKit POST handler:
 *
 *   import { mintOpenAIRealtimeSecret } from 'a2ui-svelte/agent/openai';
 *   export const POST = async ({ locals }) => {
 *     if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
 *     try {
 *       const token = await mintOpenAIRealtimeSecret({ apiKey: OPENAI_API_KEY });
 *       return json({ token });
 *     } catch (e) {
 *       return json({ error: 'Mint failed' }, { status: 502 });
 *     }
 *   };
 */
export async function mintOpenAIRealtimeSecret(
	opts: MintOpenAIRealtimeSecretOptions
): Promise<string> {
	const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
	const res = await fetch(`${baseUrl}/realtime/client_secrets`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			expires_after: { anchor: 'created_at', seconds: opts.expiresInSeconds ?? 600 },
			session: {
				type: 'realtime',
				model: opts.model ?? 'gpt-realtime-2',
				...(opts.session ?? {})
			}
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OpenAI client-secret mint failed (${res.status}): ${body.slice(0, 300)}`);
	}
	const json = (await res.json()) as { value?: string; client_secret?: { value?: string } };
	const value = json.value ?? json.client_secret?.value;
	if (!value) {
		throw new Error('OpenAI did not return a client secret');
	}
	return value;
}
