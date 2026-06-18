import { error } from '@sveltejs/kit';
import { apiKey } from '$lib/server/providers';
import { proxyToUpstream } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

/**
 * Dev proxy for the Gemini **text** (request/response) path. The browser-side
 * `GeminiTextTransport` is pointed here via its `baseUrl`, so the real
 * `GEMINI_API_KEY` stays server-only — the client only sends a placeholder.
 * The `@google/genai` SDK builds paths like
 * `/v1beta/models/<model>:streamGenerateContent?alt=sse`; this catch-all
 * mirrors them onto the real host with the key injected as `x-goog-api-key`.
 *
 * The voice path doesn't use this — Gemini Live mints a short-lived token via
 * `/api/voice-token/gemini` instead.
 */
const proxy: RequestHandler = async ({ params, url, request }) => {
	const key = apiKey.gemini();
	if (!key) error(503, 'GEMINI_API_KEY is not set — see .env.template.');
	return proxyToUpstream({
		upstreamBase: 'https://generativelanguage.googleapis.com',
		path: params.path,
		search: url.search,
		request,
		inject: { 'x-goog-api-key': key }
	});
};

export const POST = proxy;
export const GET = proxy;
