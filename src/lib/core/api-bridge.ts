/**
 * API Bridge — factory for creating agent tools from API endpoint configurations.
 *
 * Pages can register API endpoints as convenience tools, giving the agent
 * direct shortcuts for CRUD operations alongside the generic UI tools.
 */

import type { ToolDefinition } from './registries/tool-registry';

export interface ApiToolConfig {
	/** Tool name as seen by the agent (e.g., "add_staff") */
	name: string;
	/** Human-readable description for the LLM */
	description: string;
	/** API endpoint path (e.g., "/api/staff") */
	endpoint: string;
	/** HTTP method */
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	/** JSON Schema describing the tool parameters for Gemini */
	parameters: Record<string, any>;
	/** Optional: build a custom request from args (for parameterized URLs like /api/staff/[id]) */
	buildRequest?: (args: Record<string, any>) => { url: string; body?: any };
}

/**
 * Creates a ToolDefinition from an API endpoint configuration.
 *
 * @param config - The API tool configuration
 * @param onSuccess - Optional callback after a successful request (e.g., invalidateAll)
 * @returns A ToolDefinition ready for toolRegistry.register()
 */
export function createApiTool(config: ApiToolConfig, onSuccess?: () => Promise<void>): ToolDefinition {
	return {
		name: config.name,
		description: config.description,
		parameters: config.parameters,
		execute: async (args: Record<string, any>) => {
			const { url, body } = config.buildRequest
				? config.buildRequest(args)
				: { url: config.endpoint, body: config.method !== 'GET' ? args : undefined };

			const fetchOptions: RequestInit = {
				method: config.method,
				headers: { 'Content-Type': 'application/json' }
			};

			if (body) {
				fetchOptions.body = JSON.stringify(body);
			}

			const res = await fetch(url, fetchOptions);
			const data = await res.json();

			if (!res.ok) {
				return { status: 'error', error: data.error || `Request failed with status ${res.status}` };
			}

			await onSuccess?.();
			return { status: 'success', ...data };
		}
	};
}
