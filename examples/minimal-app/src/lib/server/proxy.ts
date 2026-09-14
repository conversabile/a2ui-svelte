/**
 * Same-origin key-injection proxy for the text models.
 *
 * The browser-side text models (`GeminiTextModel`,
 * `AnthropicTextModel`, `OpenAITextModel`) are pointed at a
 * `/api/<provider>` route via their `baseUrl` option and send a *placeholder*
 * credential. This helper mirrors whatever path the provider SDK produced onto
 * the real upstream, swaps the placeholder for the real key (server-side), and
 * streams the (often SSE) response straight back — so the key never reaches
 * the browser.
 *
 * Hop-by-hop and fetch-managed headers are dropped; `accept-encoding` in
 * particular is stripped so the upstream replies uncompressed and the body
 * passes through with just its `content-type`.
 */
const DROP_REQUEST_HEADERS = new Set([
	'host',
	'connection',
	'content-length',
	'accept-encoding',
	'transfer-encoding'
]);

export async function proxyToUpstream(opts: {
	/** Upstream origin (+ any fixed prefix), e.g. `https://api.openai.com/v1`. */
	upstreamBase: string;
	/** The catch-all `[...path]` segment the SDK appended after the baseUrl. */
	path: string;
	/** `url.search` from the incoming request (query string, if any). */
	search: string;
	request: Request;
	/** Real credential headers to inject (override the browser's placeholder). */
	inject: Record<string, string>;
}): Promise<Response> {
	const headers = new Headers(opts.request.headers);
	for (const name of DROP_REQUEST_HEADERS) headers.delete(name);
	for (const [name, value] of Object.entries(opts.inject)) headers.set(name, value);

	const method = opts.request.method;
	const upstream = await fetch(`${opts.upstreamBase}/${opts.path}${opts.search}`, {
		method,
		headers,
		body: method === 'GET' || method === 'HEAD' ? undefined : await opts.request.text()
	});

	// Pass the (streaming) body through unbuffered; forward only the headers a
	// browser needs (the body is already decompressed by fetch).
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'application/json',
			'cache-control': 'no-store'
		}
	});
}
