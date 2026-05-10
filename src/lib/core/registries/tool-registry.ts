/**
 * Global Tool Registry for the A2UI agent framework.
 *
 * Components (e.g. Button) register tools here so the agent can invoke them
 * via Gemini Live API native function calling.
 */

export interface ToolDefinition {
	/** Unique tool name, e.g. "click_primary_click" */
	name: string;
	/** Human-readable description for the LLM */
	description: string;
	/**
	 * JSON Schema describing the function parameters.
	 * Use `{ type: 'object', properties: {} }` for no-arg tools.
	 */
	parameters: Record<string, any>;
	/** The function to execute when the tool is called. Returns a result object. */
	execute: (args: Record<string, any>) => Promise<Record<string, any>>;
}

class ToolRegistry {
	private tools: Map<string, ToolDefinition> = new Map();

	/** Register a tool. Overwrites any existing tool with the same name. */
	register(tool: ToolDefinition) {
		console.log(`[ToolRegistry] Registered tool: ${tool.name}`);
		this.tools.set(tool.name, tool);
	}

	/** Remove a tool by name. */
	unregister(name: string) {
		console.log(`[ToolRegistry] Unregistered tool: ${name}`);
		this.tools.delete(name);
	}

	/**
	 * Returns Gemini-format function declarations suitable for
	 * `config.tools[0].functionDeclarations`.
	 */
	getDeclarations(): Array<{ name: string; description: string; parameters: Record<string, any> }> {
		return Array.from(this.tools.values()).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}));
	}

	/**
	 * Execute a tool by name. Returns the result object.
	 * Throws if the tool is not found.
	 */
	async execute(name: string, args: Record<string, any> = {}): Promise<Record<string, any>> {
		const tool = this.tools.get(name);
		if (!tool) {
			console.error(`[ToolRegistry] Tool not found: ${name}`);
			return { error: `Tool "${name}" is not registered` };
		}
		console.log(`[ToolRegistry] Executing tool: ${name}`, args);
		try {
			const result = await tool.execute(args);
			console.log(`[ToolRegistry] Tool "${name}" completed:`, result);
			return result;
		} catch (e: any) {
			console.error(`[ToolRegistry] Tool "${name}" failed:`, e);
			return { error: e.message || 'Tool execution failed' };
		}
	}

	/** Check whether any tools are registered. */
	get hasTools(): boolean {
		return this.tools.size > 0;
	}

	/** Return number of registered tools. */
	get size(): number {
		return this.tools.size;
	}
}

export const toolRegistry = new ToolRegistry();
