import { json, error } from '@sveltejs/kit';
import { mintGeminiToken } from 'a2ui-svelte/agent/gemini';
import { mintOpenAIRealtimeSecret } from 'a2ui-svelte/agent/openai';
import { mintDeepgramToken } from 'a2ui-svelte/agent/deepgram';
import { fetchHumeAccessToken } from 'a2ui-svelte/agent/hume';
import { apiKey } from '$lib/server/providers';
import type { RequestHandler } from './$types';

/**
 * One token mint for every voice transport: `POST /api/voice-token/<provider>`
 * → `{ token }`. Each provider's real API key stays server-side; the browser
 * only ever receives the short-lived credential its transport connects with
 * (Gemini ephemeral token, OpenAI Realtime client secret, Deepgram grant JWT,
 * Hume OAuth access token).
 */
export const POST: RequestHandler = async ({ params }) => {
	switch (params.provider) {
		case 'gemini': {
			const key = apiKey.gemini();
			if (!key) error(503, 'GEMINI_API_KEY is not set — see .env.template.');
			return json({ token: await mintGeminiToken({ apiKey: key }) });
		}
		case 'openai': {
			const key = apiKey.openai();
			if (!key) error(503, 'OPENAI_API_KEY is not set — see .env.template.');
			return json({ token: await mintOpenAIRealtimeSecret({ apiKey: key }) });
		}
		case 'deepgram': {
			const key = apiKey.deepgram();
			if (!key) error(503, 'DEEPGRAM_API_KEY is not set — see .env.template.');
			return json({ token: await mintDeepgramToken({ apiKey: key }) });
		}
		case 'hume': {
			const key = apiKey.hume();
			const secret = apiKey.humeSecret();
			if (!key || !secret) {
				error(503, 'HUME_API_KEY / HUME_SECRET_KEY are not set — see .env.template.');
			}
			return json({ token: await fetchHumeAccessToken({ apiKey: key, secretKey: secret }) });
		}
		default:
			error(404, `Unknown voice provider "${params.provider}"`);
	}
};
