/**
 * Pure-function decomposition of the system prompt assembled for a voice
 * session. Each block takes typed inputs and returns a string (or empty
 * string when the input is empty). The full prompt is the concatenation
 * of all non-empty blocks separated by a blank line.
 *
 * The block contents are tuned for Gemini Live and were extracted verbatim
 * from the previous GeminiLive.svelte monolith. Library users wanting a
 * different prompt should pass `buildPrompt` to VoiceAgent rather than
 * editing these defaults.
 */

export interface PromptInputs {
	systemInstruction: string;
	staticSurfaces: Array<{ id: string; getJson(): unknown }>;
	dynamicSurfaces: Array<{ id: string; getJson(): unknown }>;
	toolDeclarations: Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}>;
	contextInstructions: string;
	transcriptHistory: Array<{ role: 'user' | 'model'; text: string }>;
	/** Whether to include the dynamic-surface mini-spec in the prompt. */
	includeDynamicGuide: boolean;
}

export function buildSystemPrompt(inputs: PromptInputs): string {
	return [
		inputs.systemInstruction,
		staticSurfacesBlock(inputs.staticSurfaces),
		dynamicSurfacesBlock(inputs.dynamicSurfaces, inputs.includeDynamicGuide),
		toolsBlock(inputs.toolDeclarations),
		contextBlock(inputs.contextInstructions),
		historyBlock(inputs.transcriptHistory)
	]
		.filter((s) => s.length > 0)
		.join('\n\n');
}

export function staticSurfacesBlock(surfaces: PromptInputs['staticSurfaces']): string {
	if (surfaces.length === 0) return '';

	let out =
		'## Static Surfaces\nThe application UI has the following static surfaces rendered natively by Svelte. You CANNOT change their component structure, but you can reference them. You CAN interact with them using the available function tools (e.g. clicking buttons).\n';
	for (const s of surfaces) {
		out += `\n### Static Surface ("${s.id}")\n\`\`\`json\n${JSON.stringify(s.getJson(), null, 2)}\n\`\`\``;
	}
	out += '\n\n**CRITICAL RULES FOR STATIC SURFACES:**\n';
	out +=
		'1. **USE GENERIC TOOLS**: To interact with static surface components, use `click_button(clicks: [{element_id}])` for buttons and `update_text_field(updates: [{element_id, value}])` for text fields. Always pass an array, even for a single operation. When performing multiple operations of the same type, batch them in one call. The `element_id` matches the component ID shown in the surface JSON above. **If you confirm you are changing a text field, you MUST actually call the tool to do it.**\n';
	out +=
		'2. **SHORT ACKNOWLEDGEMENTS AFTER TOOL CALLS**: After a tool is successfully invoked and returns, keep your acknowledgement extremely short (e.g., "Done!" or "Updated."). Do not repeat the explanation of what you just did or what you were about to do.\n';
	out +=
		"3. **FORM FILLING**: When adding or editing data, fill form fields with `update_text_field` first, then immediately click the save button with `click_button` — do NOT ask for confirmation. If the user's request is incomplete, fill what you can and ask for the missing details. **EXCEPTION**: For deletion operations, always ask for confirmation before proceeding.\n";
	out +=
		'4. **SURFACE UPDATES**: You may receive messages tagged with `<event>SURFACE_UPDATED</event>`. These are automatic notifications that the UI has changed (e.g., the user added an employee, navigated weeks, or modified shifts through the UI). When you receive these:\n' +
		'   - Silently update your understanding of the current state from `<updated_surfaces>`, `<updated_context>` and `<available_element_ids>`. **The static-surface JSON shown at session start is now stale; trust `<updated_surfaces>` as the authoritative new structure and values.**\n' +
		'   - Do NOT speak or generate audio in response, unless the user is clearly waiting for your commentary on the change\n' +
		'   - Never read the XML tags or raw data aloud\n' +
		'   - `<updated_surfaces>` is the full JSON of the static surfaces after the change, in the same shape as the static-surface JSON at session start\n' +
		'   - `<updated_context>` contains the current page-specific knowledge (staff list, assignments, current week, …)\n' +
		'   - `<available_element_ids>` lists all component IDs you can target with `click_button` or `update_text_field`\n';
	out +=
		'5. **BATCH OPERATIONS**: When you need to perform multiple operations of the same type (e.g., assigning shifts to many employees), always batch them into a single tool call. Do NOT call the tool once per item. This is critical for performance and reliability.\n';
	out += '\n### Examples of Tool Usage for Static Surfaces\n';
	out += `
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
	return out;
}

export function dynamicSurfacesBlock(
	surfaces: PromptInputs['dynamicSurfaces'],
	includeGuide: boolean
): string {
	if (surfaces.length === 0 && !includeGuide) return '';

	const fallbackId = surfaces[0]?.id || 'ai-canvas';

	let out =
		'## Dynamic Surfaces\nYou have a dynamic UI canvas you can populate with components using the `render_a2ui` tool.\n';
	for (const s of surfaces) {
		out += `\n### Dynamic Surface: "${s.id}"\n\`\`\`json\n${JSON.stringify(s.getJson(), null, 2)}\n\`\`\``;
	}

	out += `

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
The full A2UI v0.8 standard catalog (16 component types). Component definitions are wrapped under their type key. Properties use value objects as described above.
- **Text**: \`{ "Text": { "text": <valueObject>, "usageHint": "h1" | "h2" | "h3" | "h4" | "h5" | "body" | "caption" } }\`
- **Image**: \`{ "Image": { "url": <valueObject>, "fit": "cover" | "contain" | "fill" | "none" | "scaleDown", "usageHint": "<free-form hint>" } }\`
- **Icon**: \`{ "Icon": { "name": <valueObject> } }\` — \`name\` is one of: check, x, plus, minus, search, menu, home, user, calendar, clock, trash, edit, info, alert, star, heart, mail, settings, chevron-right, chevron-left, chevron-down, chevron-up
- **Divider**: \`{ "Divider": { "axis": "horizontal" | "vertical" } }\`  (visual separator)
- **Button**: \`{ "Button": { "primary": true, "child": "<id-of-child-component>", "action": { "name": "my_action" } } }\`
  *(\`child\` is an ID reference to another component — typically a Text — not a raw string)*
- **TextField**: \`{ "TextField": { "label": <valueObject>, "text": <valueObject>, "textFieldType": "shortText" | "longText" | "number" | "date" | "obscured" } }\`
- **CheckBox**: \`{ "CheckBox": { "label": <valueObject>, "value": <valueObject (boolean)> } }\`
- **Slider**: \`{ "Slider": { "value": <valueObject (number)>, "minValue": 0, "maxValue": 100 } }\`
- **DateTimeInput**: \`{ "DateTimeInput": { "value": <valueObject>, "enableDate": true, "enableTime": false } }\` — set \`enableTime: true\` for HH:MM time capture; \`enableDate: false, enableTime: true\` for time-only
- **MultipleChoice**: \`{ "MultipleChoice": { "options": [ { "label": <valueObject>, "value": "<v>" } ], "selections": { "path": "/..." }, "maxAllowedSelections": 1 } }\`
- **Column**: \`{ "Column": { "children": { "explicitList": ["<id1>", "<id2>"] }, "distribution": "start", "alignment": "stretch" } }\`  (vertical stack)
- **Row**: \`{ "Row": { "children": { "explicitList": ["<id1>", "<id2>"] }, "distribution": "start", "alignment": "center" } }\`  (horizontal)
- **List**: \`{ "List": { "children": { "explicitList": ["<id1>", "<id2>"] }, "direction": "vertical" | "horizontal" } }\`
- **Card**: \`{ "Card": { "child": "<id1>" } }\`  (single-child card container — wrap multiple elements in a Column/Row)
- **Modal**: \`{ "Modal": { "entryPointChild": "<id-of-trigger>", "contentChild": "<id-of-overlay-content>" } }\`
- **Tabs**: \`{ "Tabs": { "tabItems": [ { "title": <valueObject>, "child": "<id>" } ] } }\`

### The dataModelUpdate tool (A2UI v0.8)
\`dataModelUpdate\` takes:
- \`surfaceId\`: target surface
- \`path\` (optional): JSON-Pointer location inside the data model (e.g. \`"/user"\`). **If omitted, \`contents\` REPLACES the entire data model for the surface** — so prefer a path for incremental updates.
- \`contents\`: an adjacency list. Each entry has a \`key\` and exactly ONE typed value: \`valueString\`, \`valueNumber\`, \`valueBoolean\`, or \`valueMap\` (an array of further entries to build a nested object).

**Example** — set \`/mise-en-place-text\` at the root:
\`\`\`
dataModelUpdate(
  surfaceId: "${fallbackId}",
  path: "/",
  contents: [
    { key: "mise-en-place-text", valueString: "**Linee guida**\\n1. ..." }
  ]
)
\`\`\`

**Example** — update a nested field without clobbering siblings:
\`\`\`
dataModelUpdate(
  surfaceId: "${fallbackId}",
  path: "/user",
  contents: [ { key: "email", valueString: "alice@new.com" } ]
)
\`\`\`

### Full flow example — editable text field bound to the data model
1. Push the components with \`surfaceUpdate\`:
\`\`\`
surfaceUpdate(
  surfaceId: "${fallbackId}",
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
  surfaceId: "${fallbackId}",
  path: "/",
  contents: [ { key: "mise-en-place-text", valueString: "**Linee guida**\\n1. Tovagliato ..." } ]
)
\`\`\`
3. Begin rendering:
\`\`\`
beginRendering(
  surfaceId: "${fallbackId}",
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
    "surfaceId": "${fallbackId}",
    "sourceComponentId": "save-btn",
    "timestamp": "2026-05-16T14:32:07.000Z",
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
9. Only target dynamic surfaces: ${surfaces.map((s) => '"' + s.id + '"').join(', ') || 'N/A'}.
`;
	return out;
}

export function toolsBlock(tools: PromptInputs['toolDeclarations']): string {
	if (tools.length === 0) return '';
	return (
		'## Available Function Tools\nYou have the following function tools available. Call them as needed:\n' +
		tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n')
	);
}

export function contextBlock(context: string): string {
	if (!context) return '';
	return `## Page-Specific Expert Knowledge\n${context}`;
}

export function historyBlock(history: PromptInputs['transcriptHistory']): string {
	const filtered = history.filter((m) => m.text.trim()).slice(-30);
	if (filtered.length === 0) return '';
	return (
		'## Recent Conversation History\nBelow is a transcript of our previous conversation in this session. Use this for context to provide a seamless experience, but do NOT read it aloud or repeat it back to the user. The user will speak first now.\n\n' +
		filtered.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')
	);
}
