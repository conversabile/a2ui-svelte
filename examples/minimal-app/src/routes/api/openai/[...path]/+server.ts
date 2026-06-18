import { error } from '@sveltejs/kit';
import { apiKey } from '$lib/server/providers';
import { proxyToUpstream } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

/**
 * Dev proxy for the OpenAI **text** (Chat Completions) path. The browser-side
 * `OpenAITextTransport` is pointed here via its `baseUrl`, so the real
 * `OPENAI_API_KEY` stays server-only — the client only sends a placeholder
 * bearer token. The `openai` SDK builds `/chat/completions` (the `/v1` lives
 * in the upstream base here, since a custom `baseURL` drops it); this catch-all
 * mirrors it onto the real host with `Authorization` swapped in.
 *
 * The voice path doesn't use this — OpenAI Realtime mints a client secret via
 * `/api/voice-token/openai` instead.
 */
const proxy: RequestHandler = async ({ params, url, request }) => {
	const key = apiKey.openai();
	if (!key) error(503, 'OPENAI_API_KEY is not set — see .env.template.');
	return proxyToUpstream({
		upstreamBase: 'https://api.openai.com/v1',
		path: params.path,
		search: url.search,
		request,
		inject: { authorization: `Bearer ${key}` }
	});
};

export const POST = proxy;
export const GET = proxy;
