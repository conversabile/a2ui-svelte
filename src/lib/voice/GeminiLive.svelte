<script lang="ts">
	import { onDestroy } from 'svelte';
	import { GoogleGenAI, Modality } from '@google/genai';
	import { AudioRecorder } from './audio-recorder';
	import { AudioPlayer } from './audio-player';
	import { processMessage } from '../core/processor';
	import { toolRegistry } from '../core/registries/tool-registry';
	import { actionRegistry } from '../core/registries/action-registry';
	import { userActionBus, type UserAction } from '../core/registries/event-bus';

	interface Props {
		geminiEnabled: boolean;
		surfaces: any[]; // Array of surface component instances (StaticSurface or DynamicSurface)
		mode?: 'static' | 'dynamic' | 'both';
		model?: string;
		systemInstruction?: string;
		/** Per-page expert knowledge injected into the system prompt when the session connects */
		contextInstructions?: string;
	}

	let {
		geminiEnabled,
		surfaces = [],
		mode = 'static',
		// model = 'gemini-2.5-flash-native-audio-preview-12-2025',
		// model = 'gemini-2.5-flash-native-audio-preview-09-2025',
		model = 'gemini-3.1-flash-live-preview',
		systemInstruction = 'You are a helpful and friendly AI assistant; be brief and on point. NEVER use emojis. Always speak in the language of the user\'s request. If you don\'t know the answer to something, say you don\'t know. If the user asks you to do something outside your capabilities, politely decline.',
		contextInstructions = ''
	}: Props = $props();

	let isRecording = $state(false);
	let audioRecorder: AudioRecorder | null = null;
	let audioPlayer: AudioPlayer | null = null;
	let session: any = null;
	let connected = $state(false);
	let statusBadge = $state<'thinking' | 'error' | null>(null);
	let intentionalDisconnect = false;

	/** Call when the model produces output (audio, text) — clears "thinking" */
	function onModelActivity() {
		if (statusBadge === 'thinking') statusBadge = null;
	}

	// Transcript state
	let transcript = $state<Array<{ role: 'user' | 'model'; text: string }>>([]);
	let currentModelText = $state('');
	let canAppendToUser = false; // Flag to track if we can append to the last user message
	let textInput = $state('');
	// Keep track of whether we've ever connected to show the transcript box
	let hasStarted = $state(false);
	let isChatOpen = $state(false);

	// --- Surface watch: push UI changes to the agent during an active session ---
	let surfaceWatchInterval: ReturnType<typeof setInterval> | null = null;
	let lastSurfaceSnapshot = '';
	let lastContextSnapshot = '';
	let lastSurfaceIds = '';
	let lastAgentModificationTime = 0;

	function getSurfaceSnapshot(): string {
		return JSON.stringify(surfaces.filter((s) => s && s.type === 'static').map((s) => s.getJson()));
	}

	function getSurfaceIds(): string {
		return surfaces.filter((s) => s).map((s) => s.id).join(',');
	}

	function startSurfaceWatch() {
		lastSurfaceSnapshot = getSurfaceSnapshot();
		lastContextSnapshot = contextInstructions;
		lastSurfaceIds = getSurfaceIds();

		surfaceWatchInterval = setInterval(() => {
			if (!session || !connected) return;
			if (surfaces.length === 0 || surfaces.every((s) => !s)) return;

			const currentSurface = getSurfaceSnapshot();
			const currentContext = contextInstructions;
			const currentSurfaceIds = getSurfaceIds();

			if (currentSurface !== lastSurfaceSnapshot || currentContext !== lastContextSnapshot) {
				// Prevent glitch: do not notify the agent of a surface update if the agent itself
				// just modified it (via tool call) within the last few seconds.
				// EXCEPTION: If the active surface IDs changed (e.g. page navigation), ALWAYS notify!
				if (Date.now() - lastAgentModificationTime > 5000 || currentSurfaceIds !== lastSurfaceIds) {
					pushSurfaceUpdate(currentContext);
				}
				lastSurfaceSnapshot = currentSurface;
				lastContextSnapshot = currentContext;
				lastSurfaceIds = currentSurfaceIds;
			}
		}, 3000);
	}

	function stopSurfaceWatch() {
		if (surfaceWatchInterval) {
			clearInterval(surfaceWatchInterval);
			surfaceWatchInterval = null;
		}
	}

	function pushSurfaceUpdate(context: string) {
		const elementIds = actionRegistry.listActions().join(', ');
		const message = `<event>SURFACE_UPDATED</event>\n<updated_context>\n${context}\n</updated_context>\n<available_element_ids>\n${elementIds}\n</available_element_ids>`;

		try {
			console.log('[GeminiLive] Pushing surface update to agent');
			session.sendRealtimeInput({ text: message });
		} catch (e: any) {
			console.warn('[GeminiLive] Failed to push surface update:', e);
		}
	}

	let showConfigPrompt = $state(false);

	/** Unsubscribe handle for the A2UI userAction bus. */
	let userActionUnsub: (() => void) | null = null;

	/**
	 * Forward a dynamic-surface `userAction` (e.g. Button click) to the agent.
	 *
	 * Per A2UI v0.8 (docs/a2ui/guides/renderer-development.md § Client-to-Server
	 * Communication), when a user interacts with a component carrying an
	 * `action`, the renderer constructs a `userAction` payload with the
	 * action's `context` resolved against the data model, and sends it to the
	 * server event handler. For a Gemini Live session we don't have a separate
	 * event endpoint, so we serialise the payload into a tagged text event the
	 * model has been instructed to interpret.
	 */
	function sendUserAction(action: UserAction) {
		if (!session || !connected) {
			console.warn('[GeminiLive] Dropping userAction — no active session:', action);
			return;
		}
		if (statusBadge !== 'error') statusBadge = 'thinking';
		const payload = {
			userAction: {
				name: action.name,
				surfaceId: action.surfaceId,
				componentId: action.componentId,
				context: action.context
			}
		};
		const message = `<event>USER_ACTION</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
		try {
			console.log('[GeminiLive] Forwarding userAction to agent:', payload);
			session.sendRealtimeInput({ text: message });
		} catch (e: any) {
			console.warn('[GeminiLive] Failed to forward userAction:', e);
		}
	}

	async function startLive() {
		statusBadge = null;
		intentionalDisconnect = false;
		if (!geminiEnabled) {
			showConfigPrompt = true;
			return;
		}

		try {
			// Fetch ephemeral token from server
			const tokenRes = await fetch('/api/gemini-token', { method: 'POST' });
			if (!tokenRes.ok) {
				const data = await tokenRes.json();
				alert(data.error || 'Failed to get Gemini token');
				return;
			}
			const { token } = await tokenRes.json();

			const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

			// Build dynamic surface definition block
			let surfaceBlock = '';

			if (mode === 'static' || mode === 'both') {
				const staticSurfaces = surfaces.filter((s) => s && s.type === 'static');
				if (staticSurfaces.length > 0) {
					surfaceBlock +=
						'\n\n## Static Surfaces\nThe application UI has the following static surfaces rendered natively by Svelte. You CANNOT change their component structure, but you can reference them. You CAN interact with them using the available function tools (e.g. clicking buttons).\n';
					for (const s of staticSurfaces) {
						surfaceBlock += `\n### Static Surface ("${s.id}")\n\`\`\`json\n${JSON.stringify(s.getJson(), null, 2)}\n\`\`\``;
					}
					surfaceBlock += '\n\n**CRITICAL RULES FOR STATIC SURFACES:**\n';
					surfaceBlock +=
						'1. **USE GENERIC TOOLS**: To interact with static surface components, use `click_button(clicks: [{element_id}])` for buttons and `update_text_field(updates: [{element_id, value}])` for text fields. Always pass an array, even for a single operation. When performing multiple operations of the same type, batch them in one call. The `element_id` matches the component ID shown in the surface JSON above. **If you confirm you are changing a text field, you MUST actually call the tool to do it.**\n';
					surfaceBlock +=
						'2. **SHORT ACKNOWLEDGEMENTS AFTER TOOL CALLS**: After a tool is successfully invoked and returns, keep your acknowledgement extremely short (e.g., "Done!" or "Updated."). Do not repeat the explanation of what you just did or what you were about to do.\n';
					surfaceBlock +=
						"3. **FORM FILLING**: When adding or editing data, fill form fields with `update_text_field` first, then immediately click the save button with `click_button` — do NOT ask for confirmation. If the user's request is incomplete, fill what you can and ask for the missing details. **EXCEPTION**: For deletion operations, always ask for confirmation before proceeding.\n";
					surfaceBlock +=
						'4. **SURFACE UPDATES**: You may receive messages tagged with `<event>SURFACE_UPDATED</event>`. These are automatic notifications that the UI has changed (e.g., the user added an employee, navigated weeks, or modified shifts through the UI). When you receive these:\n' +
						'   - Silently update your understanding of the current state from `<updated_context>` and `<available_element_ids>`\n' +
						'   - Do NOT speak or generate audio in response, unless the user is clearly waiting for your commentary on the change\n' +
						'   - Never read the XML tags or raw data aloud\n' +
						'   - `<updated_context>` contains the current page state (staff list, assignments, current week)\n' +
						'   - `<available_element_ids>` lists all component IDs you can target with `click_button` or `update_text_field`\n';
					surfaceBlock +=
						'5. **BATCH OPERATIONS**: When you need to perform multiple operations of the same type (e.g., assigning shifts to many employees), always batch them into a single tool call. Do NOT call the tool once per item. This is critical for performance and reliability.\n';
					surfaceBlock += '\n### Examples of Tool Usage for Static Surfaces\n';
					surfaceBlock += `
**Scenario 1: Navigation**
User: "Vorrei rivedere il regolamento base del servizio"
Surface JSON has a Button with id "go_my_restaurant".
Agent Action: Call click_button(clicks: [{element_id: "go_my_restaurant"}]) and say "Certamente, ti porto subito a Il Mio Ristorante."

**Scenario 2: Content Update**
User: "Scrivi la ricetta della carbonara nel campo ricetta"
Surface JSON has a TextField with id "recipe".
Agent Action: Call update_text_field(updates: [{element_id: "recipe", value: "## Spaghetti alla Carbonara\\n1. Bollire l'acqua..."}]) and say "Fatto!"

**Scenario 3: Form Filling**
User: "Aggiungi un cameriere"
Surface JSON has TextFields with ids "add-staff-name" and "add-staff-role", and a Button with id "add-staff-btn".
Agent Action: Call update_text_field(updates: [{element_id: "add-staff-role", value: "Cameriere"}]), then ask "Come si chiama?" and wait for the user's response before filling the name and clicking save.

**Scenario 4: Bulk Shift Assignment**
User: "Assegna il turno Mattina a tutto il personale per lunedì"
Surface JSON has shift cells for each employee on Monday.
Agent Action: Call update_text_field(updates: [{element_id: "shift-abc123-2026-04-06", value: "Mattina"}, {element_id: "shift-def456-2026-04-06", value: "Mattina"}, {element_id: "shift-ghi789-2026-04-06", value: "Mattina"}]) — all in one call. Say "Fatto! Ho assegnato il turno Mattina a tutti per lunedì."

**Scenario 5: Chained Form Submissions (Multiple Items)**
User: "Aggiungi due cuochi: Mario e Paolo"
Surface JSON has TextFields with ids "add-staff-name" and "add-staff-role", and a Button with id "add-staff-btn".
Agent Action (First item):
  1. Call update_text_field(updates: [{element_id: "add-staff-name", value: "Mario"}, {element_id: "add-staff-role", value: "Cuoco"}])
  2. Call click_button(clicks: [{element_id: "add-staff-btn"}])
  3. WAIT for the successful tool result, stop if there's an error
  4. Now fill and submit for the second item without asking for confirmation, the user should see a smooth flow of adding both items one after the other:
  5. Call update_text_field(updates: [{element_id: "add-staff-name", value: "Paolo"}, {element_id: "add-staff-role", value: "Cuoco"}])
  6. Call click_button(clicks: [{element_id: "add-staff-btn"}])
  7. Inform the user that the operation is complete: "Fatto! Ho aggiunto Mario e Paolo come cuochi."

**KEY**: Always wait between submissions. After clicking save, wait for the form to reset (or for a SURFACE_UPDATED event) before filling the same form again. Do NOT fill multiple items into the same form at once — that will overwrite previous entries.
`;
				}
			}

			const dynamicSurfaces =
				mode === 'dynamic' || mode === 'both'
					? surfaces.filter((s) => s && s.type === 'dynamic')
					: [];

			if (mode === 'dynamic' || mode === 'both') {
				if (dynamicSurfaces.length > 0 || mode === 'dynamic') {
					surfaceBlock +=
						'\n\n## Dynamic Surfaces\nYou have a dynamic UI canvas you can populate with components using the `render_a2ui` tool.\n';
					for (const s of dynamicSurfaces) {
						surfaceBlock += `\n### Dynamic Surface: "${s.id}"\n\`\`\`json\n${JSON.stringify(s.getJson(), null, 2)}\n\`\`\``;
					}

					surfaceBlock += `

## How to use A2UI Dynamic Tools
You can modify the UI by calling the A2UI v0.8 spec tools: \`surfaceUpdate\`, \`beginRendering\`, and \`dataModelUpdate\`.
A2UI cleanly separates **structure** (components, pushed with \`surfaceUpdate\`) from **state** (the data model, pushed with \`dataModelUpdate\`). Components bind to the data model via JSON-Pointer paths; when the data changes, bound components automatically re-render.

### Value objects (CRITICAL)
Every text/number/boolean property on a component MUST be wrapped in a **value object**. Never pass a raw string. Use one of:
- \`{ "literalString": "fixed text" }\` — a hard-coded literal
- \`{ "literalNumber": 42 }\` or \`{ "literalBoolean": true }\`
- \`{ "path": "/some/pointer" }\` — a **data binding** to a JSON-Pointer path in the surface's data model

**WRONG** (do NOT do this): \`{ "Text": { "text": "Hello" } }\` or \`{ "TextField": { "text": "{{mise-en-place-text}}" } }\`
**RIGHT**: \`{ "Text": { "text": { "literalString": "Hello" } } }\` or \`{ "TextField": { "text": { "path": "/mise-en-place-text" } } }\`

Never invent mustache/handlebars placeholders like \`{{foo}}\` — A2UI does not interpolate strings. If you want a dynamic value, use \`{ "path": "/foo" }\` and push the value with \`dataModelUpdate\`.

### Available component types
Component definitions are wrapped under their type key. Properties use value objects as described above.
- **Text**: \`{ "Text": { "text": <valueObject>, "usageHint": "h1" | "h2" | "h3" | "body" | "caption" } }\`
- **Button**: \`{ "Button": { "primary": true, "child": "<id-of-child-component>", "action": { "name": "my_action" } } }\`
  *(\`child\` is an ID reference to another component — typically a Text — not a raw string)*
- **Column**: \`{ "Column": { "children": { "explicitList": ["<id1>", "<id2>"] } } }\`  (vertical stack)
- **Row**: \`{ "Row": { "children": { "explicitList": ["<id1>", "<id2>"] } } }\`  (horizontal)
- **Card**: \`{ "Card": { "children": { "explicitList": ["<id1>"] } } }\`  (card container)
- **TextField**: \`{ "TextField": { "label": <valueObject>, "text": <valueObject>, "textFieldType": "shortText" | "longText" | "number" | "date" | "time" | "obscured" } }\` — use \`"time"\` for HH:MM time inputs (values are strings like \`"12:30"\`)

### The dataModelUpdate tool (A2UI v0.8)
\`dataModelUpdate\` takes:
- \`surfaceId\`: target surface
- \`path\` (optional): JSON-Pointer location inside the data model (e.g. \`"/user"\`). **If omitted, \`contents\` REPLACES the entire data model for the surface** — so prefer a path for incremental updates.
- \`contents\`: an adjacency list. Each entry has a \`key\` and exactly ONE typed value: \`valueString\`, \`valueNumber\`, \`valueBoolean\`, or \`valueMap\` (an array of further entries to build a nested object).

**Example** — set \`/mise-en-place-text\` at the root:
\`\`\`
dataModelUpdate(
  surfaceId: "${dynamicSurfaces[0]?.id || 'ai-canvas'}",
  path: "/",
  contents: [
    { key: "mise-en-place-text", valueString: "**Linee guida**\\n1. ..." }
  ]
)
\`\`\`

**Example** — update a nested field without clobbering siblings:
\`\`\`
dataModelUpdate(
  surfaceId: "${dynamicSurfaces[0]?.id || 'ai-canvas'}",
  path: "/user",
  contents: [ { key: "email", valueString: "alice@new.com" } ]
)
\`\`\`

### Full flow example — editable text field bound to the data model
1. Push the components with \`surfaceUpdate\`:
\`\`\`
surfaceUpdate(
  surfaceId: "${dynamicSurfaces[0]?.id || 'ai-canvas'}",
  components: [
    { id: "main-col", component: { Column: { children: { explicitList: ["title", "editor"] } } } },
    { id: "title",    component: { Text: { text: { literalString: "Mise en Place" }, usageHint: "h2" } } },
    { id: "editor",   component: { TextField: { label: { literalString: "Contenuto" }, text: { path: "/mise-en-place-text" }, textFieldType: "longText" } } }
  ]
)
\`\`\`
2. Seed the data model with \`dataModelUpdate\`:
\`\`\`
dataModelUpdate(
  surfaceId: "${dynamicSurfaces[0]?.id || 'ai-canvas'}",
  path: "/",
  contents: [ { key: "mise-en-place-text", valueString: "**Linee guida**\\n1. Tovagliato ..." } ]
)
\`\`\`
3. Begin rendering:
\`\`\`
beginRendering(
  surfaceId: "${dynamicSurfaces[0]?.id || 'ai-canvas'}",
  root: "main-col"
)
\`\`\`
Because the TextField's \`text\` is bound via \`{ "path": "/mise-en-place-text" }\`, any later \`dataModelUpdate\` to that path will reactively refresh the field — you do NOT need to re-push the component.

### Interactivity — Button actions and \`USER_ACTION\` events (A2UI v0.8)
To make a Button clickable, declare an \`action\` on it. The action has a \`name\` (an arbitrary identifier YOU choose to recognise later) and an optional \`context\` — an adjacency list of \`{ key, value }\` entries where each \`value\` is a value object (\`literalString\`/\`path\`/…). The client will resolve any \`path\` bindings in the context against the current data model **at the moment of click**, then forward a \`userAction\` payload to you as a text event.

**Declaring an action on a Button:**
\`\`\`
{
  id: "save-btn",
  component: {
    Button: {
      primary: true,
      child: "save-btn-label",
      action: {
        name: "save_mise_en_place",
        context: [
          { key: "text",         value: { path: "/mise-en-place-text" } },
          { key: "restaurantId", value: { path: "/restaurant-id" } }
        ]
      }
    }
  }
}
\`\`\`
(Don't forget to also push \`{ id: "save-btn-label", component: { Text: { text: { literalString: "Salva" } } } }\`.)

**What you receive when the user clicks it:**
You will get a realtime text message shaped like:
\`\`\`
<event>USER_ACTION</event>
<payload>
{
  "userAction": {
    "name": "save_mise_en_place",
    "surfaceId": "${dynamicSurfaces[0]?.id || 'ai-canvas'}",
    "componentId": "save-btn",
    "context": {
      "text": "**Linee guida**\\n1. Tovagliato …",
      "restaurantId": "abc123"
    }
  }
}
</payload>
\`\`\`
When you receive a \`USER_ACTION\` event:
- Do NOT read the XML tags or payload aloud.
- Look at \`userAction.name\` to decide what to do. The \`context\` object already has every \`path\` binding resolved to its current data-model value, so you can use it directly as tool arguments.
- Typically you will chain it to a backend call (e.g. call an API tool with values from \`context\`) and then, if appropriate, update the UI via \`dataModelUpdate\` / \`surfaceUpdate\` and speak a short acknowledgement ("Salvato!").
- If the action name is something you don't recognise, ask the user briefly what they expected.

**RULES:**
1. Always use \`surfaceUpdate\`, \`dataModelUpdate\`, and \`beginRendering\` tools — never output component JSON in your transcript.
2. Every text/number/bool property on a component MUST be a value object (\`{literalString|literalNumber|literalBoolean|path: ...}\`). Never raw strings, never mustache placeholders.
3. The UI will only appear after \`beginRendering\` is called with the root component ID.
4. Prefer \`dataModelUpdate\` (with path binding) over re-sending \`surfaceUpdate\` when only content changes.
5. When using \`dataModelUpdate\` at the root, pass \`path: "/"\` and only the keys you want — be aware that omitting \`path\` entirely REPLACES the whole data model per A2UI v0.8.
6. Any Button you want the user to be able to click MUST carry an \`action: { name, context? }\`. Without an action the button is inert — you will never hear about its clicks.
7. Prefer binding \`action.context\` entries via \`{ path: "/..." }\` over literals, so you always get the **latest** value the user has typed (the data model is updated in real-time as the user edits bound TextFields).
8. When you receive a \`<event>USER_ACTION</event>\` message, treat it as a trigger — react silently by calling tools or updating the UI, then speak a short confirmation.
9. Only target dynamic surfaces: ${dynamicSurfaces.map((s: any) => '"' + s.id + '"').join(', ') || 'N/A'}.
`;
				}
			}

			// Build tools config from registered tools
			const toolDeclarations = toolRegistry.getDeclarations();

			const allToolDeclarations = [...toolDeclarations];

			if (mode === 'dynamic' || mode === 'both') {
				allToolDeclarations.unshift({
					name: 'dataModelUpdate',
					description:
						"Updates the data model of a dynamic surface (A2UI v0.8). Components bound via {path: '...'} automatically re-render when their target path changes. Prefer this over re-sending surfaceUpdate when only content changes.",
					parameters: {
						type: 'object',
						properties: {
							surfaceId: { type: 'string', description: 'Target dynamic surface ID' },
							path: {
								type: 'string',
								description:
									"Optional JSON-Pointer location to update (e.g. '/user' or '/'). If omitted entirely, contents REPLACES the entire data model for the surface — so pass '/' to merge at the root without clobbering siblings."
							},
							contents: {
								type: 'array',
								description:
									'Adjacency list of data entries. Each entry has a `key` and exactly one typed value: `valueString`, `valueNumber`, `valueBoolean`, or `valueMap` (recursive list of further entries).',
								items: {
									type: 'object',
									properties: {
										key: { type: 'string' },
										valueString: { type: 'string' },
										valueNumber: { type: 'number' },
										valueBoolean: { type: 'boolean' },
										valueMap: {
											type: 'array',
											description:
												'Nested adjacency list — builds a nested object under this key.',
											items: { type: 'object' }
										}
									},
									required: ['key']
								}
							}
						},
						required: ['surfaceId', 'contents']
					}
				});

				allToolDeclarations.unshift({
					name: 'beginRendering',
					description: 'Sets the root component to be rendered on the dynamic surface.',
					parameters: {
						type: 'object',
						properties: {
							surfaceId: { type: 'string' },
							root: { type: 'string', description: 'ID of the root component' }
						},
						required: ['surfaceId', 'root']
					}
				});

				allToolDeclarations.unshift({
					name: 'surfaceUpdate',
					description: 'Pushes UI component definitions to a dynamic surface.',
					parameters: {
						type: 'object',
						properties: {
							surfaceId: { type: 'string' },
							components: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										id: { type: 'string' },
										component: { type: 'object' }
									},
									required: ['id', 'component']
								}
							}
						},
						required: ['surfaceId', 'components']
					}
				});
			}

			const toolsConfig =
				allToolDeclarations.length > 0
					? [{ functionDeclarations: allToolDeclarations }]
					: undefined;

			if (allToolDeclarations.length > 0) {
				console.log(
					'[GeminiLive] Registering tools with session:',
					allToolDeclarations.map((t) => t.name)
				);
				surfaceBlock += `\n\n## Available Function Tools\nYou have the following function tools available. Call them as needed:\n${allToolDeclarations.map((t) => `- **${t.name}**: ${t.description}`).join('\n')}\n`;
			}

			const config: Record<string, any> = {
				responseModalities: [Modality.AUDIO],
				systemInstruction:
					systemInstruction +
					surfaceBlock +
					(contextInstructions
						? `\n\n## Page-Specific Expert Knowledge\n${contextInstructions}`
						: '') +
					(transcript.length > 0
						? `\n\n## Recent Conversation History\nBelow is a transcript of our previous conversation in this session. Use this for context to provide a seamless experience, but do NOT read it aloud or repeat it back to the user. The user will speak first now.\n\n${transcript
								.filter((m) => m.text.trim())
								.slice(-30)
								.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
								.join('\n')}`
						: ''),
				speechConfig: {
					voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }
				}
			};

			if (toolsConfig) {
				config.tools = toolsConfig;
			}

			audioRecorder = new AudioRecorder();
			audioPlayer = new AudioPlayer(24000);

			session = await ai.live.connect({
				model: model,
				// @ts-ignore
				config: {
					...config,
					inputAudioTranscription: {},
					outputAudioTranscription: {}
				},
				callbacks: {
					onopen: () => {
						connected = true;
						hasStarted = true;
						canAppendToUser = false;
						console.log('[GeminiLive] Connected');
						startSurfaceWatch();
						// Subscribe to A2UI userAction events from dynamic surfaces
						// and forward them into the live session. Per A2UI v0.8,
						// this is the client → agent edge of the data flow.
						userActionUnsub = userActionBus.subscribe(sendUserAction);
					},
					onmessage: async (message: any) => {
						// Handle tool calls from Gemini
						if (message.toolCall) {
							if (statusBadge !== 'error') statusBadge = 'thinking';
							lastAgentModificationTime = Date.now();
							console.log(
								'[GeminiLive] Received tool call message:',
								JSON.stringify(message.toolCall, null, 2)
							);
							const functionResponses: Array<{
								id: string;
								name: string;
								response: Record<string, any>;
							}> = [];

							for (const fc of message.toolCall.functionCalls) {
								console.log(`[GeminiLive] -> Executing: ${fc.name}`, fc.args);
								let result: any;
								try {
									if (
										fc.name === 'surfaceUpdate' ||
										fc.name === 'beginRendering' ||
										fc.name === 'dataModelUpdate'
									) {
										const args = fc.args || {};
										console.log(`[GeminiLive] ${fc.name} args:`, JSON.stringify(args, null, 2));
										try {
											processMessage({ [fc.name]: args } as any);
											result = { status: 'success' };
										} catch (err: any) {
											console.error(`[GeminiLive] Failed processing ${fc.name}:`, err);
											result = { status: 'error', error: err.message };
										}
									} else {
										result = await toolRegistry.execute(fc.name, fc.args || {});

										// Note: we no longer override result.updatedSurface here.
										// The tools themselves (e.g. click_button) now wait for SvelteKit 
										// navigations to settle and return the true global surface snapshot natively.

										// Update the watchdog snapshots IMMEDIATELY with the new global state 
										// so the interval doesn't detect this change and fire a duplicate SURFACE_UPDATED event.
										// Svelte state is already updated since the tool itself waited for the tick/navigation.
										lastSurfaceSnapshot = getSurfaceSnapshot();
										lastContextSnapshot = contextInstructions;
										lastSurfaceIds = getSurfaceIds();
									}
								} catch (e: any) {
									console.error(`[GeminiLive] Tool "${fc.name}" execution failed:`, e);
									result = { status: 'error', error: e.message || 'Unknown tool error' };
								}

								functionResponses.push({
									id: fc.id,
									name: fc.name,
									response: result
								});
							}

							console.log(
								'[GeminiLive] Sending tool responses:',
								JSON.stringify(functionResponses, null, 2)
							);
							try {
								// Some SDK versions might prefer .send({ functionResponses })
								// but let's stick to what was there with more logging
								if (typeof session.sendToolResponse === 'function') {
									session.sendToolResponse({ functionResponses });
								} else {
									console.warn(
										'[GeminiLive] session.sendToolResponse is not a function, falling back to session.send'
									);
									session.send({ functionResponses });
								}
							} catch (sendError: any) {
								console.error('[GeminiLive] Failed to send tool response:', sendError);
								statusBadge = 'error';
							}
							return;
						}

						if (message.serverContent && message.serverContent.interrupted) {
							audioPlayer?.stop();
							if (statusBadge !== 'error') statusBadge = 'thinking';
							return;
						}

						const modelTurn = message.serverContent?.modelTurn;
						if (modelTurn?.parts) {
							for (const part of modelTurn.parts) {
								if (part.inlineData?.data) {
									audioPlayer?.addToQueue(part.inlineData.data);
									onModelActivity();
									canAppendToUser = false;
								}
							}
						}

						if (message.serverContent?.outputTranscription) {
							const text = message.serverContent.outputTranscription.text;
							if (text) {
								onModelActivity();
								canAppendToUser = false;
								currentModelText += text;
								const lastIndex = transcript.length - 1;
								if (lastIndex >= 0 && transcript[lastIndex].role === 'model') {
									transcript[lastIndex].text = currentModelText;
								} else {
									transcript = [...transcript, { role: 'model', text: currentModelText }];
								}
							}
						}

						if (message.serverContent?.inputTranscription) {
							const text = message.serverContent.inputTranscription.text;
							if (text) {
								if (statusBadge !== 'error') statusBadge = 'thinking';
								const lastIndex = transcript.length - 1;
								if (canAppendToUser && lastIndex >= 0 && transcript[lastIndex].role === 'user') {
									transcript[lastIndex].text += text;
								} else {
									transcript = [...transcript, { role: 'user', text: text }];
									canAppendToUser = true;
								}
							}
						}

						if (message.serverContent?.turnComplete) {
							if (currentModelText.trim()) {
								const lastIndex = transcript.length - 1;
								if (lastIndex >= 0 && transcript[lastIndex].role === 'model') {
									transcript[lastIndex].text = currentModelText;
								}
								currentModelText = '';
								canAppendToUser = false;
							}
							if (statusBadge === 'thinking') statusBadge = null;
						}
					},
					onerror: (e: any) => {
						console.error('[GeminiLive] Error event:', JSON.stringify(e, null, 2));
						console.error('[GeminiLive] Error message:', e.message);
						if (!intentionalDisconnect) statusBadge = 'error';
						stopLive();
					},
					onclose: (e: any) => {
						console.log(e);
						console.log('[GeminiLive] Connection closed:', JSON.stringify(e, null, 2));
						console.log('[GeminiLive] Close reason:', e.reason);
						if (!intentionalDisconnect) statusBadge = 'error';
						stopLive();
					}
				}
			});


			audioRecorder.addEventListener('data', (e: any) => {
				if (!connected || !session) return;
				session.sendRealtimeInput({
					audio: { data: e.detail, mimeType: 'audio/pcm;rate=16000' }
				});
			});

			await audioRecorder.start();
			isRecording = true;
		} catch (error: any) {
			console.error('[GeminiLive] Failed:', error);
			const msg = error?.message || 'Unknown error';
			if (msg.includes('secure context') || msg.includes('getUserMedia')) {
				alert(msg);
			}
			stopLive();
		}
	}

	async function stopLive() {
		stopSurfaceWatch();
		if (userActionUnsub) {
			userActionUnsub();
			userActionUnsub = null;
		}
		if (session) {
			try {
				// @ts-ignore
				if (session.close) session.close();
				// @ts-ignore
				if (session.disconnect) session.disconnect();
			} catch {}
		}
		if (audioRecorder) audioRecorder.stop();
		if (audioPlayer) audioPlayer.stop();

		if (currentModelText.trim()) {
			transcript = [...transcript, { role: 'model', text: currentModelText.trim() }];
			currentModelText = '';
		}

		session = null;
		audioRecorder = null;
		audioPlayer = null;
		isRecording = false;
		connected = false;
		canAppendToUser = false;
	}

	async function toggleLive() {
		if (connected) {
			intentionalDisconnect = true;
			statusBadge = null;
			await stopLive();
		} else {
			await startLive();
		}
	}

	async function clearConversation() {
		if (connected) {
			intentionalDisconnect = true;
			await stopLive();
		}
		statusBadge = null;
		transcript = [];
		currentModelText = '';
		canAppendToUser = false;
		hasStarted = false;
		isChatOpen = false;
	}

	async function sendTextMessage(e: Event) {
		e.preventDefault();
		const text = textInput.trim();
		if (!text) return;

		if (statusBadge !== 'error') statusBadge = 'thinking';

		// Optimistically add to transcript
		transcript = [...transcript, { role: 'user', text }];
		canAppendToUser = false; // Ensure next model message starts fresh
		textInput = '';

		if (session) {
			// session.send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }] } });
			session.sendRealtimeInput({
				text: text
			});
		} else {
			console.warn('[GeminiLive] Cannot send text message: session is closed.');
		}
	}

	onDestroy(() => {
		stopLive();
	});
</script>

<div class="gemini-live-bar" class:glowing={connected}>
	<!-- Chat Window -->
	{#if hasStarted && isChatOpen}
		<div class="chat-wrapper border-bottom">
			<div class="chat-container container">
				<div class="transcript">
					{#if transcript.length === 0 && !currentModelText}
						<p class="placeholder"><em>{connected ? 'Listening...' : 'Live session is paused'}</em></p>
					{/if}
					{#each transcript as message}
						<div class="message {message.role}">
							<strong>{message.role === 'user' ? 'You' : 'Gemini'}:</strong>
							{message.text}
						</div>
					{/each}
					{#if currentModelText}
						<div class="message model streaming">
							<strong>Gemini:</strong>
							{currentModelText}
						</div>
					{/if}
				</div>

				<form onsubmit={sendTextMessage}>
					<fieldset role="group">
						<input
							type="text"
							bind:value={textInput}
							placeholder={connected ? 'Type a message...' : 'Start live session to type...'}
							disabled={!connected}
						/>
						<button type="submit" disabled={!connected || !textInput.trim()}>Send</button>
					</fieldset>
				</form>
			</div>
		</div>
	{/if}

	<!-- AI Configuration Prompt -->
	{#if showConfigPrompt}
		<div class="config-prompt border-bottom">
			<div class="config-prompt-inner container">
				<p>
					AI assistant is not configured. <a href="/profile"
						>Set up your Gemini API key or link a Google account in your profile.</a
					>
				</p>
				<button class="outline secondary" onclick={() => (showConfigPrompt = false)}>Dismiss</button
				>
			</div>
		</div>
	{/if}

	<!-- Bottom Controls Bar -->
	<div class="gemini-live-controls container">
		<div class="left-controls">
			{#if hasStarted}
				<button
					class="reset-convo-btn outline secondary"
					onclick={clearConversation}
					aria-label="New Conversation"
					title="New Conversation"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
						<path d="M3 3v5h5" />
					</svg>
				</button>
			{/if}
		</div>

		<div class="mic-container">
			<button
				class="mic-button {connected ? '' : 'outline primary'}"
				onclick={toggleLive}
				aria-label={connected ? 'Stop Live' : 'Start Live'}
				title={connected ? 'Stop Live' : 'Start Live'}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
					<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
					<line x1="12" x2="12" y1="19" y2="22" />
				</svg>
			</button>
			{#if statusBadge}
				<span class="status-badge {statusBadge}">{statusBadge === 'thinking' ? 'thinking...' : 'error'}</span>
			{/if}
		</div>

		<div class="right-controls">
			{#if hasStarted}
				<button
					class="expand-btn outline secondary"
					onclick={() => (isChatOpen = !isChatOpen)}
					aria-label={isChatOpen ? 'Collapse Chat' : 'Expand Chat'}
					title={isChatOpen ? 'Collapse Chat' : 'Expand Chat'}
				>
					{#if isChatOpen}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
						>
					{:else}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg
						>
					{/if}
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.gemini-live-bar {
		position: fixed;
		bottom: 0;
		left: clamp(220px, 18vw, 450px);
		right: 0;
		background: var(--pico-card-background-color);
		border-top: 1px solid var(--pico-muted-border-color);
		z-index: 999;
		padding: 0.5rem 1rem;
		transition:
			box-shadow 0.3s ease,
			border-top-color 0.3s ease;
	}

	@media (max-width: 768px) {
		.gemini-live-bar {
			left: 0;
		}
	}

	.gemini-live-bar.glowing {
		box-shadow: 0px -4px 20px var(--pico-primary-focus);
		border-top-color: var(--pico-primary-border);
	}

	.config-prompt {
		border-bottom: 1px solid var(--pico-muted-border-color);
	}

	.config-prompt-inner {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.config-prompt-inner p {
		margin: 0;
		flex: 1;
	}

	.config-prompt-inner button {
		margin: 0;
		white-space: nowrap;
	}

	.chat-wrapper.border-bottom {
		border-bottom: 1px solid var(--pico-muted-border-color);
	}

	.chat-container {
		height: 50vh;
		display: flex;
		flex-direction: column;
		padding-top: 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.gemini-live-controls {
		background: var(--pico-card-background-color);
		display: flex;
		justify-content: space-between;
		align-items: center;
		height: 70px;
		padding: 0 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.left-controls,
	.right-controls {
		flex: 1;
	}

	.left-controls {
		display: flex;
		justify-content: flex-start;
	}

	.right-controls {
		display: flex;
		justify-content: flex-end;
	}

	.transcript {
		flex: 1;
		border: 1px solid var(--pico-border-color);
		border-radius: var(--pico-border-radius);
		padding: 1rem;
		overflow-y: auto;
		background: var(--pico-card-sectioning-background-color);
		margin-bottom: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.05);
	}
	.message {
		padding: 0.8rem;
		border-radius: var(--pico-border-radius);
		line-height: 1.5;
		max-width: 85%;
	}
	.message.user {
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
		align-self: flex-end;
		border-bottom-right-radius: 2px;
	}
	.message.model {
		background: var(--pico-secondary-background);
		color: var(--pico-secondary-inverse);
		align-self: flex-start;
		border-bottom-left-radius: 2px;
	}
	.message.streaming {
		opacity: 0.8;
		visibility: hidden;
	}
	.placeholder {
		color: var(--pico-muted-color);
		text-align: center;
	}

	.mic-container {
		flex: 0 0 auto;
		display: flex;
		justify-content: center;
		align-items: center;
		position: relative;
	}

	.status-badge {
		position: absolute;
		left: calc(100% + 8px);
		top: 50%;
		transform: translateY(-50%);
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
		pointer-events: none;
	}

	.status-badge.thinking {
		color: var(--pico-primary);
		animation: pulse-opacity 1.5s ease-in-out infinite;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.status-badge.thinking::before {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		background-color: var(--pico-primary);
		border-radius: 50%;
	}

	.status-badge.error {
		color: var(--pico-del-color);
	}

	@keyframes pulse-opacity {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.3; }
	}

	.mic-button {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
		box-shadow: var(--pico-box-shadow);
	}

	.mic-button:not(.outline) {
		animation: pulse-border 2s infinite;
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
	}

	.mic-button svg {
		width: 24px;
		height: 24px;
	}

	.reset-convo-btn {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
	}

	.expand-btn {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
	}

	.expand-btn svg {
		width: 20px;
		height: 20px;
	}

	@keyframes pulse-border {
		0% {
			box-shadow: 0 0 0 0 var(--pico-primary-focus);
		}
		70% {
			box-shadow: 0 0 0 15px transparent;
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}
</style>
