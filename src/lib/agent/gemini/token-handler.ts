import { GoogleGenAI } from '@google/genai';

export interface MintGeminiTokenOptions {
	/** Server-side Gemini API key. Caller is responsible for selecting the right one (per-user vs. shared). */
	apiKey: string;
	/** Token expiry in milliseconds from now. Default 30 minutes. */
	expireMs?: number;
	/** New-session expiry in milliseconds. Default 1 minute (matches Gemini Live recommendation). */
	newSessionExpireMs?: number;
	/** API version. Default 'v1alpha' (required for Gemini Live). */
	apiVersion?: string;
}

/**
 * Mint a single-use ephemeral token for Gemini Live. Throws on failure with a
 * normalised Error — callers translate to HTTP responses.
 *
 * Usage in a SvelteKit POST handler:
 *
 *   import { mintGeminiToken } from 'a2ui-svelte/agent/gemini';
 *   export const POST = async ({ locals }) => {
 *     if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
 *     const apiKey = await resolveUserApiKey(locals.user);
 *     if (!apiKey) return json({ error: 'No key configured' }, { status: 403 });
 *     try {
 *       const token = await mintGeminiToken({ apiKey });
 *       return json({ token });
 *     } catch (e) {
 *       return json({ error: 'Mint failed' }, { status: 502 });
 *     }
 *   };
 */
export async function mintGeminiToken(opts: MintGeminiTokenOptions): Promise<string> {
	const expireMs = opts.expireMs ?? 30 * 60 * 1000;
	const newSessionExpireMs = opts.newSessionExpireMs ?? 60 * 1000;
	const apiVersion = opts.apiVersion ?? 'v1alpha';

	const ai = new GoogleGenAI({ apiKey: opts.apiKey });
	const token = await ai.authTokens.create({
		config: {
			uses: 1,
			expireTime: new Date(Date.now() + expireMs).toISOString(),
			newSessionExpireTime: new Date(Date.now() + newSessionExpireMs).toISOString(),
			httpOptions: { apiVersion }
		}
	});
	if (!token?.name) {
		throw new Error('Gemini did not return a token name');
	}
	return token.name;
}
