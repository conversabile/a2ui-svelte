import { error } from '@sveltejs/kit';
import { apiKey } from '$lib/server/providers';
import { proxyToUpstream } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

/**
 * Dev proxy for the Anthropic **text** path. The browser-side
 * `AnthropicTextTransport` is pointed here via its `baseUrl`, so the real
 * `ANTHROPIC_API_KEY` stays server-only — the client only sends a placeholder
 * `x-api-key`. The `@anthropic-ai/sdk` builds `/v1/messages`; this catch-all
 * mirrors it onto the real host with the key swapped in. The SDK's own
 * `anthropic-version` header rides through untouched.
 */
const proxy: RequestHandler = async ({ params, url, request }) => {
	const key = apiKey.anthropic();
	if (!key) error(503, 'ANTHROPIC_API_KEY is not set — see .env.template.');
	return proxyToUpstream({
		upstreamBase: 'https://api.anthropic.com',
		path: params.path,
		search: url.search,
		request,
		inject: { 'x-api-key': key }
	});
};

export const POST = proxy;
export const GET = proxy;
