import { error } from '@sveltejs/kit';
import { GEMINI_API_KEY } from '$env/static/private';
import type { RequestHandler } from './$types';

/**
 * Dev proxy for the Gemini **text** (request/response) path.
 *
 * The browser-side `GeminiTextTransport` is pointed here via its `baseUrl`
 * option, so the real `GEMINI_API_KEY` stays server-only — the client never
 * sees it. The `@google/genai` SDK builds paths like
 * `/v1beta/models/<model>:streamGenerateContent?alt=sse`; this catch-all
 * mirrors whatever path it produces onto the real host, injects the key as the
 * `x-goog-api-key` header (overriding the client's placeholder), and streams the
 * SSE response straight back.
 *
 * The voice path doesn't use this — Gemini Live mints a short-lived token via
 * `/api/voice-token` instead.
 */
const UPSTREAM = 'https://generativelanguage.googleapis.com';

const proxy: RequestHandler = async ({ params, url, request }) => {
	if (!GEMINI_API_KEY) {
		error(503, 'GEMINI_API_KEY is not set. Run `GEMINI_API_KEY=... pnpm dev`.');
	}

	const target = `${UPSTREAM}/${params.path}${url.search}`;
	const upstream = await fetch(target, {
		method: request.method,
		headers: {
			'content-type': request.headers.get('content-type') ?? 'application/json',
			// Inject the real key here — the browser only ever sent a placeholder.
			'x-goog-api-key': GEMINI_API_KEY
		},
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
	});

	// Pass the (streaming SSE) body straight through without buffering.
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'application/json',
			'cache-control': 'no-store'
		}
	});
};

export const POST = proxy;
export const GET = proxy;
