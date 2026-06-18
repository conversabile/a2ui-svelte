import { json } from '@sveltejs/kit';
import { availability } from '$lib/server/providers';

/**
 * Which providers have a real key configured (booleans only — never the
 * keys). The layout fetches this once and enables/disables the model
 * picker's options accordingly.
 */
export function GET() {
	return json(availability());
}
