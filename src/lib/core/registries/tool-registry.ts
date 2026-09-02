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
	/**
	 * Providers per tool name, in registration order — the LAST one is live.
	 * Two mounted surfaces each register their own `click_button`; unmounting
	 * one must leave the other's still declared, so a name keeps a stack of
	 * providers rather than a single value.
	 */
	private tools: Map<string, ToolDefinition[]> = new Map();

	/** Register a tool. It becomes the live provider for its name. */
	register(tool: ToolDefinition) {
		const stack = this.tools.get(tool.name);
		if (!stack) {
			this.tools.set(tool.name, [tool]);
			return;
		}
		const existing = stack.indexOf(tool);
		if (existing !== -1) stack.splice(existing, 1);
		stack.push(tool);
	}

	/**
	 * Remove a tool. Given a `tool`, removes only that provider — whichever
	 * provider registered before it becomes live again; without one, removes
	 * every provider of the name.
	 */
	unregister(name: string, tool?: ToolDefinition) {
		if (!tool) {
			this.tools.delete(name);
			return;
		}
		const stack = this.tools.get(name);
		if (!stack) return;
		const idx = stack.indexOf(tool);
		if (idx !== -1) stack.splice(idx, 1);
		if (stack.length === 0) this.tools.delete(name);
	}

	/** The live provider for a name — the most recently registered one. */
	private current(name: string): ToolDefinition | undefined {
		const stack = this.tools.get(name);
		return stack?.[stack.length - 1];
	}

	/**
	 * Returns Gemini-format function declarations suitable for
	 * `config.tools[0].functionDeclarations`.
	 */
	getDeclarations(): Array<{ name: string; description: string; parameters: Record<string, any> }> {
		return Array.from(this.tools.keys()).map((name) => {
			const t = this.current(name)!;
			return { name: t.name, description: t.description, parameters: t.parameters };
		});
	}

	/**
	 * Execute a tool by name. Returns the result object.
	 * Throws if the tool is not found.
	 */
	async execute(name: string, args: Record<string, any> = {}): Promise<Record<string, any>> {
		const tool = this.current(name);
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
