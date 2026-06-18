export interface FetchHumeAccessTokenOptions {
	/** Server-side Hume API key. */
	apiKey: string;
	/** Server-side Hume secret key (paired with the API key for the OAuth client-credentials grant). */
	secretKey: string;
	/** API base URL. Default `'https://api.hume.ai'`. */
	baseUrl?: string;
}

/**
 * Fetch a short-lived OAuth access token for `HumeEviTransport` (client
 * credentials grant — Hume's tokens last 30 minutes). Throws on failure with
 * a normalised Error — callers translate to HTTP responses.
 *
 * Usage in a SvelteKit POST handler:
 *
 *   import { fetchHumeAccessToken } from 'a2ui-svelte/agent/hume';
 *   export const POST = async ({ locals }) => {
 *     if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
 *     try {
 *       const token = await fetchHumeAccessToken({
 *         apiKey: HUME_API_KEY,
 *         secretKey: HUME_SECRET_KEY
 *       });
 *       return json({ token });
 *     } catch (e) {
 *       return json({ error: 'Mint failed' }, { status: 502 });
 *     }
 *   };
 */
export async function fetchHumeAccessToken(opts: FetchHumeAccessTokenOptions): Promise<string> {
	const baseUrl = opts.baseUrl ?? 'https://api.hume.ai';
	const credentials = btoa(`${opts.apiKey}:${opts.secretKey}`);
	const res = await fetch(`${baseUrl}/oauth2-cc/token`, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${credentials}`,
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: 'grant_type=client_credentials'
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Hume access-token fetch failed (${res.status}): ${body.slice(0, 300)}`);
	}
	const json = (await res.json()) as { access_token?: string };
	if (!json.access_token) {
		throw new Error('Hume did not return an access token');
	}
	return json.access_token;
}
