import { json, error } from '@sveltejs/kit';
import { mintGeminiToken } from 'a2ui-svelte/voice/gemini';
import { GEMINI_API_KEY } from '$env/static/private';

export async function POST() {
	if (!GEMINI_API_KEY) {
		error(503, 'GEMINI_API_KEY is not set. Run `GEMINI_API_KEY=... pnpm dev`.');
	}
	const token = await mintGeminiToken({ apiKey: GEMINI_API_KEY });
	return json({ token });
}
