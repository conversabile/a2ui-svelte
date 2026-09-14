/**
 * Pure-function decomposition of the system prompt assembled by the neutral
 * `Agent`. Each block takes typed inputs and
 * returns a string (or empty string when the input is empty). The full prompt
 * is the concatenation of all non-empty blocks separated by a blank line.
 *
 * The blocks are channel-agnostic. History is optional: server-history
 * models (voice) embed the recent transcript here for reconnect
 * continuity, while client-history models (text) own `messages[]` and omit
 * it (pass `includeHistory: false` or no `transcriptHistory`). Library users
 * wanting a different prompt should pass `buildPrompt` to the agent rather than
 * editing these defaults.
 */

import { getExtensions } from "../core/extensions";

/** Shape of a surface as seen by the prompt-builder. */
export interface PromptSurface {
  id: string;
  getJson(): unknown;
}

export interface PromptInputs {
  systemInstruction: string;
  staticSurfaces: PromptSurface[];
  dynamicSurfaces: PromptSurface[];
  toolDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  contextInstructions: string;
  /**
   * Prior conversation turns to embed in the prompt. Optional — server-history
   * models (voice) supply it for reconnect continuity; client-history
   * models (text) own `messages[]` and omit it.
   */
  transcriptHistory?: Array<{ role: "user" | "model"; text: string }>;
  /**
   * Force-omit the history block even when `transcriptHistory` is non-empty.
   * Defaults to including history when present. Client-history models pass
   * `false`.
   */
  includeHistory?: boolean;
  /** Whether to include the dynamic-surface mini-spec in the prompt. */
  includeDynamicGuide: boolean;
  /**
   * Serialize embedded surface JSON compactly (single line) instead of
   * pretty-printed. Pretty-printing a dense surface roughly doubles its
   * character count in pure indentation/newlines — tokens the model is billed
   * for on every turn. Semantically identical JSON either way; default false
   * (pretty) for backwards compatibility.
   */
  compactSurfaceJson?: boolean;
}

export function buildSystemPrompt(inputs: PromptInputs): string {
  const history =
    inputs.includeHistory === false ? [] : inputs.transcriptHistory ?? [];
  return [
    inputs.systemInstruction,
    staticSurfacesBlock(inputs.staticSurfaces, {
      compactSurfaceJson: inputs.compactSurfaceJson,
    }),
    dynamicSurfacesBlock(inputs.dynamicSurfaces, inputs.includeDynamicGuide, {
      compactSurfaceJson: inputs.compactSurfaceJson,
    }),
    toolsBlock(inputs.toolDeclarations),
    contextBlock(inputs.contextInstructions),
    historyBlock(history),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function staticSurfacesBlock(
  surfaces: PromptInputs["staticSurfaces"],
  opts: { compactSurfaceJson?: boolean } = {},
): string {
  if (surfaces.length === 0) return "";

  // The extensions are app-wide, so the prompt describes exactly what the
  // tools do — no collapsing across surfaces.
  const ext = getExtensions();
  const batchToolsEnabled = ext.batchTools;
  const surfaceEcho = ext.toolResultSurfaceEcho;
  const surfaceWatchEnabled = ext.surfaceWatch;
  const pointerToolEnabled = ext.pointerTool;
  const indent = opts.compactSurfaceJson ? undefined : 2;

  let out =
    "## Static Surfaces\nThe application UI has the following static surfaces rendered natively by Svelte. You CANNOT change their component structure, but you can reference them. You CAN interact with them using the available function tools (e.g. clicking buttons).\n";
  for (const s of surfaces) {
    out += `\n### Static Surface ("${s.id}")\n\`\`\`json\n${JSON.stringify(s.getJson(), null, indent)}\n\`\`\``;
  }
  out += "\n\n**CRITICAL RULES FOR STATIC SURFACES:**\n";

  if (batchToolsEnabled) {
    out +=
      "1. **USE GENERIC TOOLS**: To interact with static surface components, use `click_button({element_id})` for a single button and `update_text_field({element_id, value})` for a single field. When you need to act on several elements at once, prefer the batched variants `click_buttons({clicks: [{element_id}, ...]})` and `update_text_fields({updates: [{element_id, value}, ...]})` — one tool call instead of many. The `element_id` matches the component ID shown in the surface JSON above. **If you confirm you are changing a text field, you MUST actually call the tool to do it.**\n";
  } else {
    out +=
      "1. **USE GENERIC TOOLS**: To interact with static surface components, use `click_button({element_id})` for buttons and `update_text_field({element_id, value})` for text fields. The `element_id` matches the component ID shown in the surface JSON above. **If you confirm you are changing a text field, you MUST actually call the tool to do it.**\n";
  }

  out +=
    '2. **SHORT ACKNOWLEDGEMENTS AFTER TOOL CALLS**: After a tool is successfully invoked and returns, keep your acknowledgement extremely short (e.g., "Done!" or "Updated."). Do not repeat the explanation of what you just did or what you were about to do.\n';
  out +=
    "3. **FORM FILLING**: When adding or editing data, fill form fields with `update_text_field` first, then immediately click the save button with `click_button` — do NOT ask for confirmation. If the user's request is incomplete, fill what you can and ask for the missing details. **EXCEPTION**: For deletion operations, always ask for confirmation before proceeding.\n";

  let ruleNo = 4;
  if (surfaceWatchEnabled) {
    out +=
      `${ruleNo}. **SURFACE UPDATES**: You may receive messages tagged with \`<event>SURFACE_UPDATED</event>\` that tell you the UI changed (the user typed into a field, navigated, or edited data through the UI). They arrive silently, attached to the user's message — the current state of the UI at the moment the user is speaking to you. Treat them as the authoritative current state. There are TWO kinds, distinguished by \`kind\` inside \`extensions["a2ui-svelte"]\`:\n` +
      "   \n" +
      '   **(a) `kind: "clientDataModel"` — a data-model update (the common case).** The values the user has entered, as a map of field id to value. **Only CHANGED fields are included.** Merge them into your understanding (upsert each key); fields not listed are unchanged. The component STRUCTURE you were shown at session start does NOT change here — only these values do.\n' +
      "   ```\n" +
      "   {\n" +
      '     "extensions": {\n' +
      '       "a2ui-svelte": {\n' +
      '         "kind": "clientDataModel",\n' +
      '         "version": "v0.9",\n' +
      '         "delta": true,\n' +
      '         "surfaces": { "<surfaceId>": { "<fieldId>": "<value>" } },\n' +
      '         "updatedContext": "..."\n' +
      "       }\n" +
      "     }\n" +
      "   }\n" +
      "   ```\n" +
      '   A field cleared by the user arrives as `"<fieldId>": ""`. No need to re-read the whole surface — just apply the changed values to the structure you already know. `updatedContext` is present only when the page context also changed.\n' +
      "   \n" +
      '   **(b) `kind: "surfaceUpdated"` — a full re-sync (structure changed).** Sent when the STRUCTURE changed (navigation, a component appeared or disappeared), because a value delta cannot convey new structure. Replace your structural understanding from `updatedSurfaces`.\n' +
      "   ```\n" +
      "   {\n" +
      '     "extensions": {\n' +
      '       "a2ui-svelte": {\n' +
      '         "kind": "surfaceUpdated",\n' +
      '         "updatedSurfaces": [ ... ],\n' +
      '         "updatedContext": "...",\n' +
      '         "availableElementIds": [ ... ]\n' +
      "       }\n" +
      "     }\n" +
      "   }\n" +
      "   ```\n" +
      "   For EITHER kind:\n" +
      "   - Do NOT speak or generate audio in response, unless the user is clearly waiting for your commentary on the change\n" +
      "   - Never read the XML tags or raw payload aloud\n" +
      "   - `updatedContext`, when present, is the current page-specific knowledge (the visible list, the selected item, the current filter, …)\n" +
      "   - `updatedSurfaces` (kind `surfaceUpdated`) is the full JSON of the static surfaces, in the same shape as the static-surface JSON at session start; `availableElementIds` lists the component IDs you can target with `click_button` / `update_text_field`\n";
    ruleNo++;
  }

  // Always taught, extension or not: every UI tool returns `results`, and the
  // two-value `status` vocabulary is the contract `builtin-tools.test.ts`
  // holds every registered tool to.
  out +=
    `${ruleNo}. **TOOL RESULTS**: Every UI tool returns \`{"results": [ { "element_id": "...", "status": "success" | "error" }, ... ]}\` — one entry per element you targeted. \`status\` is EXACTLY \`"success"\` or \`"error"\`, never any other word, and a failed element always carries an \`error\` string saying why. Read it before telling the user the action worked.\n`;
  ruleNo++;

  if (surfaceEcho === "changed") {
    out +=
      `${ruleNo}. **TOOL-RESULT ENVELOPE (changed-only)**: Every \`click_button\` / \`update_text_field\` (and their batched variants) returns a \`results\` array, plus — under \`extensions["a2ui-svelte"]\` — ONLY what the action actually changed:\n` +
      '   - `updatedSurface`: present ONLY when the component STRUCTURE changed (a component appeared or disappeared, navigation). When present, replace your structural understanding with it. When absent, the structure you already know is still current.\n' +
      '   - `updatedDataModel`: `{ "<surfaceId>": { "<fieldId>": "<value>" } }` of field values that changed — including side effects of your action (e.g. a form resetting after save). Merge them (upsert each key); fields not listed are unchanged.\n' +
      "   - `updatedContext` / `availableElementIds`: present only when they changed.\n" +
      "   If `extensions` is absent entirely, nothing changed beyond what `results` reports — do NOT re-read or re-request the surface; your current understanding is up to date.\n";
    ruleNo++;
  } else if (surfaceEcho === "full") {
    out +=
      `${ruleNo}. **TOOL-RESULT ENVELOPE**: Every \`click_button\` / \`update_text_field\` (and their batched variants) returns an envelope shaped like:\n` +
      "   ```\n" +
      "   {\n" +
      '     "results": [ { "element_id": "...", "status": "success" | "error", ... } ],\n' +
      '     "extensions": {\n' +
      '       "a2ui-svelte": {\n' +
      '         "updatedSurface": [ ... ],\n' +
      '         "updatedContext": "...",\n' +
      '         "availableElementIds": [ ... ]\n' +
      "       }\n" +
      "     }\n" +
      "   }\n" +
      "   ```\n" +
      '   The `results` field is the per-element outcome. The `extensions["a2ui-svelte"]` block is a post-action snapshot — **after every tool call, trust `updatedSurface` as the authoritative new structure and refresh your understanding from `updatedContext` and `availableElementIds`**. The original static-surface JSON shown at session start is stale the moment you act.\n';
    ruleNo++;
  }

  if (batchToolsEnabled) {
    out += `${ruleNo}. **BATCH OPERATIONS**: When you need to perform multiple operations of the same type (e.g., setting the same value on many rows), always batch them into a single \`click_buttons\` / \`update_text_fields\` call. Do NOT call the tool once per item. This is critical for performance and reliability.\n`;
    ruleNo++;
  }

  if (pointerToolEnabled) {
    out += `${ruleNo}. **POINTING THINGS OUT**: To direct the user's eye to something already on screen, call \`point_to_elements({element_ids: ["id1", ...]})\` — each component scrolls into view and glows briefly. Use it when the user asks you to *show*, *point out*, or *find* something ("where do I save this?", "show me the total"), or when you mention specific on-screen data and want to indicate where it is. It is PURELY VISUAL — it changes nothing. Do NOT use it to edit a value (use \`update_text_field\`) or to activate a control (use \`click_button\`). Keep the spoken reply short ("It's right here.") and never read the element IDs aloud.\n`;
    ruleNo++;
  }

  out += "\n### Examples of Tool Usage for Static Surfaces\n";

  if (batchToolsEnabled) {
    out += `
**Scenario 1: Navigation**
User: "I'd like to look at the archived tasks"
Surface JSON has a Button with id "go-archive".
Agent Action: Call click_button({element_id: "go-archive"}) and say "Sure, opening the archive."

**Scenario 2: Content Update**
User: "Put the shopping list in the notes for Groceries"
Surface JSON has a TextField with id "todo-groceries-notes".
Agent Action: Call update_text_field({element_id: "todo-groceries-notes", value: "Milk, bread, coffee"}) and say "Done!"

**Scenario 3: Form Filling**
User: "Add a work task"
Surface JSON has TextFields with ids "add-todo-title" and "add-todo-tag", and a Button with id "add-todo-btn".
Agent Action: Call update_text_field({element_id: "add-todo-tag", value: "Work"}), then ask "What should I call it?" and wait for the user's response before filling the title and clicking add.

**Scenario 4: Bulk Update**
User: "Set every task to High priority"
Surface JSON has a priority cell for each task.
Agent Action: Call update_text_fields({updates: [{element_id: "todo-invoices-priority", value: "High"}, {element_id: "todo-laundry-priority", value: "High"}, {element_id: "todo-gym-priority", value: "High"}]}) — all in one call. Say "Done! Every task is High priority now."

**Scenario 5: Chained Form Submissions (Multiple Items)**
User: "Add two tasks: Groceries and Laundry"
Surface JSON has TextFields with ids "add-todo-title" and "add-todo-tag", and a Button with id "add-todo-btn".
Agent Action (First item):
  1. Call update_text_fields({updates: [{element_id: "add-todo-title", value: "Groceries"}, {element_id: "add-todo-tag", value: "Home"}]})
  2. Call click_button({element_id: "add-todo-btn"})
  3. WAIT for the successful tool result, stop if there's an error
  4. Now fill and submit for the second item without asking for confirmation, the user should see a smooth flow of adding both items one after the other:
  5. Call update_text_fields({updates: [{element_id: "add-todo-title", value: "Laundry"}, {element_id: "add-todo-tag", value: "Home"}]})
  6. Call click_button({element_id: "add-todo-btn"})
  7. Inform the user that the operation is complete: "Done! I added Groceries and Laundry."

**KEY**: Always wait between submissions. After clicking save, wait for the form to reset (or for a SURFACE_UPDATED event) before filling the same form again. Do NOT fill multiple items into the same form at once — that will overwrite previous entries.
`;
  } else {
    out += `
**Scenario 1: Navigation**
User: "I'd like to look at the archived tasks"
Surface JSON has a Button with id "go-archive".
Agent Action: Call click_button({element_id: "go-archive"}) and say "Sure, opening the archive."

**Scenario 2: Content Update**
User: "Put the shopping list in the notes for Groceries"
Surface JSON has a TextField with id "todo-groceries-notes".
Agent Action: Call update_text_field({element_id: "todo-groceries-notes", value: "Milk, bread, coffee"}) and say "Done!"

**Scenario 3: Form Filling**
User: "Add a work task"
Surface JSON has TextFields with ids "add-todo-title" and "add-todo-tag", and a Button with id "add-todo-btn".
Agent Action: Call update_text_field({element_id: "add-todo-tag", value: "Work"}), then ask "What should I call it?" and wait for the user's response before filling the title and clicking add.

**Scenario 4: Chained Form Submissions (Multiple Items)**
User: "Add two tasks: Groceries and Laundry"
Surface JSON has TextFields with ids "add-todo-title" and "add-todo-tag", and a Button with id "add-todo-btn".
Agent Action (First item):
  1. Call update_text_field({element_id: "add-todo-title", value: "Groceries"})
  2. Call update_text_field({element_id: "add-todo-tag", value: "Home"})
  3. Call click_button({element_id: "add-todo-btn"})
  4. WAIT for the successful tool result, stop if there's an error
  5. Now fill and submit for the second item without asking for confirmation:
  6. Call update_text_field({element_id: "add-todo-title", value: "Laundry"})
  7. Call update_text_field({element_id: "add-todo-tag", value: "Home"})
  8. Call click_button({element_id: "add-todo-btn"})
  9. Inform the user that the operation is complete: "Done! I added Groceries and Laundry."

**KEY**: Always wait between submissions. After clicking save, wait for the form to reset (or for a SURFACE_UPDATED event) before filling the same form again. Do NOT fill multiple items into the same form at once — that will overwrite previous entries.
`;
  }

  if (pointerToolEnabled) {
    out += `
**Scenario: Pointing something out (no change)**
User: "Where do I save my changes?"
Surface JSON has a Button with id "save-btn".
Agent Action: Call point_to_elements({element_ids: ["save-btn"]}) and say "The Save button is down here."

**Scenario: Show me a value**
User: "Show me the order total"
Surface JSON has a Text with id "order-total".
Agent Action: Call point_to_elements({element_ids: ["order-total"]}) and say "Here it is, let me highlight it."
`;
  }
  return out;
}

export function dynamicSurfacesBlock(
  surfaces: PromptInputs["dynamicSurfaces"],
  includeGuide: boolean,
  opts: { compactSurfaceJson?: boolean } = {},
): string {
  if (surfaces.length === 0 && !includeGuide) return "";

  const fallbackId = surfaces[0]?.id || "ai-canvas";
  const indent = opts.compactSurfaceJson ? undefined : 2;

  let out =
    "## Dynamic Surfaces\nYou have a dynamic UI canvas you can populate with components using the `render_a2ui` tool.\n";
  for (const s of surfaces) {
    out += `\n### Dynamic Surface: "${s.id}"\n\`\`\`json\n${JSON.stringify(s.getJson(), null, indent)}\n\`\`\``;
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

**WRONG** (do NOT do this): \`{ "Text": { "text": "Hello" } }\` or \`{ "TextField": { "text": "{{notes-text}}" } }\`
**RIGHT**: \`{ "Text": { "text": { "literalString": "Hello" } } }\` or \`{ "TextField": { "text": { "path": "/notes-text" } } }\`

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

**Example** — set \`/notes-text\` at the root:
\`\`\`
dataModelUpdate(
  surfaceId: "${fallbackId}",
  path: "/",
  contents: [
    { key: "notes-text", valueString: "**Shopping list**\\n1. ..." }
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
    { id: "title",    component: { Text: { text: { literalString: "Notes" }, usageHint: "h2" } } },
    { id: "editor",   component: { TextField: { label: { literalString: "Content" }, text: { path: "/notes-text" }, textFieldType: "longText" } } }
  ]
)
\`\`\`
2. Seed the data model with \`dataModelUpdate\`:
\`\`\`
dataModelUpdate(
  surfaceId: "${fallbackId}",
  path: "/",
  contents: [ { key: "notes-text", valueString: "**Shopping list**\\n1. Milk ..." } ]
)
\`\`\`
3. Begin rendering:
\`\`\`
beginRendering(
  surfaceId: "${fallbackId}",
  root: "main-col"
)
\`\`\`
Because the TextField's \`text\` is bound via \`{ "path": "/notes-text" }\`, any later \`dataModelUpdate\` to that path will reactively refresh the field — you do NOT need to re-push the component.

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
        name: "save_notes",
        context: [
          { key: "text",   value: { path: "/notes-text" } },
          { key: "listId", value: { path: "/list-id" } }
        ]
      }
    }
  }
}
\`\`\`
(Don't forget to also push \`{ id: "save-btn-label", component: { Text: { text: { literalString: "Save" } } } }\`.)

**What you receive when the user clicks it:**
You will get a realtime text message shaped like:
\`\`\`
<event>USER_ACTION</event>
<payload>
{
  "userAction": {
    "name": "save_notes",
    "surfaceId": "${fallbackId}",
    "sourceComponentId": "save-btn",
    "timestamp": "2026-05-16T14:32:07.000Z",
    "context": {
      "text": "Milk, bread, coffee",
      "listId": "abc123"
    }
  }
}
</payload>
\`\`\`
When you receive a \`USER_ACTION\` event:
- Do NOT read the XML tags or payload aloud.
- Look at \`userAction.name\` to decide what to do. The \`context\` object already has every \`path\` binding resolved to its current data-model value, so you can use it directly as tool arguments.
- Typically you will chain it to a backend call (e.g. call an API tool with values from \`context\`) and then, if appropriate, update the UI via \`dataModelUpdate\` / \`surfaceUpdate\` and speak a short acknowledgement ("Saved!").
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
9. Only target dynamic surfaces: ${surfaces.map((s) => '"' + s.id + '"').join(", ") || "N/A"}.
`;
  return out;
}

export function toolsBlock(tools: PromptInputs["toolDeclarations"]): string {
  if (tools.length === 0) return "";
  return (
    "## Available Function Tools\nYou have the following function tools available. Call them as needed:\n" +
    tools.map((t) => `- **${t.name}**: ${t.description}`).join("\n")
  );
}

export function contextBlock(context: string): string {
  if (!context) return "";
  return `## Page-Specific Expert Knowledge\n${context}`;
}

export function historyBlock(
  history: Array<{ role: "user" | "model"; text: string }>,
): string {
  const filtered = history.filter((m) => m.text.trim()).slice(-30);
  if (filtered.length === 0) return "";
  return (
    "## Recent Conversation History\nBelow is a transcript of our previous conversation in this session. Use this for context to provide a seamless experience, but do NOT read it aloud or repeat it back to the user. The user will speak first now.\n\n" +
    filtered
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
      .join("\n")
  );
}
