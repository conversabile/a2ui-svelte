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
	/**
	 * Whether calling this tool can change what is on screen. The `Agent` uses
	 * it to decide which tool results carry the surface echo — a purely visual
	 * tool (`point_to_elements`) leaves the model's understanding unchanged and
	 * keeps its lean `{ results }`.
	 */
	mutatesSurface?: boolean;
}

class ToolRegistry {
	/** One live definition per tool name. */
	private tools: Map<string, ToolDefinition> = new Map();

	/** Register a tool, replacing any earlier one with the same name. */
	register(tool: ToolDefinition) {
		this.tools.set(tool.name, tool);
	}

	/** Remove a tool by name. */
	unregister(name: string) {
		this.tools.delete(name);
	}

	/** The registered definition for a name, or `undefined`. */
	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
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
