/// <reference types="vitest/config" />
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

/**
 * Two projects, because two kinds of test need two module resolutions:
 *
 * - `client` — jsdom + `svelteTesting()` (which pins the browser export
 *   condition): every component test that mounts something.
 * - `server` — node, no browser condition, so `svelte/server` renders a
 *   component the way SvelteKit does during SSR. Files named `*.ssr.test.ts`.
 */
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		projects: [
			{
				extends: true,
				plugins: [svelteTesting()],
				test: {
					name: 'client',
					environment: 'jsdom',
					include: ['src/**/*.{test,spec}.{ts,js}'],
					exclude: ['src/**/*.ssr.{test,spec}.{ts,js}']
				}
			},
			{
				extends: true,
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.ssr.{test,spec}.{ts,js}']
				}
			}
		]
	}
});
