import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushSync } from "svelte";
import { Agent, type AgentSurface } from "./agent.svelte";
import type {
  AgentTransport,
  AgentTransportConnectOptions,
  AgentTransportEventMap,
  TransportCapabilities,
} from "./transport";
import { toolRegistry } from "../core/registries/tool-registry";
import { userActionBus, type UserAction } from "../core/registries/event-bus";
import { ALL_EXTRAS, STRICT } from "../core/extensions";
import { serializeSurface } from "../core/serializer";
import { a2uiState } from "../core/state.svelte";

// Stub AudioRecorder/AudioPlayer so the audio suite never touches Web Audio
// (jsdom has none). Each holder captures its latest instance so a test can
// drive a 'data' event (assert what reaches the transport, e.g. mute drops it)
// or spy on the player. The Agent only constructs these when the transport's
// capabilities include the matching audio modality, so the text-profile tests
// above never instantiate them.
const recorderHolder = vi.hoisted(() => ({ last: null as EventTarget | null }));
const playerHolder = vi.hoisted(
  () =>
    ({ last: null }) as {
      last: { stop: ReturnType<typeof vi.fn>; addToQueue: ReturnType<typeof vi.fn> } | null;
    },
);
vi.mock("./audio-recorder", () => ({
  AudioRecorder: class extends EventTarget {
    constructor() {
      super();
      recorderHolder.last = this;
    }
    async start() {}
    stop() {}
  },
}));
vi.mock("./audio-player", () => ({
  AudioPlayer: class {
    stop = vi.fn();
    addToQueue = vi.fn();
    constructor(_: number) {
      playerHolder.last = this;
    }
  },
}));

// Neutral transport mock. It advertises the **streaming live profile** minus
// the audio modalities, so the channel-gated paths (poll loop, barge-in gate,
// server-held history, proactive turns) are exercised exactly as they are on
// the real GeminiLiveTransport — without the Agent spinning up the mic
// recorder / speaker player (no Web Audio in jsdom). Tests mark "the model is
// generating" with a `text-out` event (which sets `modelTurnActive`), the
// neutral equivalent of `audio-out`. The audio paths themselves are covered
// by the "audio surface" suite below against `MockAudioTransport`.
class MockAgentTransport implements AgentTransport {
  connectOpts: AgentTransportConnectOptions | null = null;
  textsSent: string[] = [];
  contextUpdates: string[] = [];
  toolResults: Array<{ id: string; name: string; result: unknown }> = [];
  closed = false;

  get capabilities(): TransportCapabilities {
    return {
      streaming: true,
      interruptible: true,
      silentContext: true,
      historyOwnership: "server",
      canInitiateTurn: true,
      input: ["text"],
      output: ["text"],
    };
  }

  #listeners: {
    [E in keyof AgentTransportEventMap]?: Set<(p: unknown) => void>;
  } = {};

  async connect(opts: AgentTransportConnectOptions) {
    this.connectOpts = opts;
  }
  sendText(text: string) {
    this.textsSent.push(text);
  }
  sendContextUpdate(text: string) {
    this.contextUpdates.push(text);
  }
  sendToolResult(id: string, name: string, result: unknown) {
    this.toolResults.push({ id, name, result });
  }
  on<E extends keyof AgentTransportEventMap>(
    event: E,
    handler: (p: AgentTransportEventMap[E]) => void,
  ): () => void {
    let set = this.#listeners[event];
    if (!set) {
      set = new Set();
      this.#listeners[event] = set;
    }
    set.add(handler as (p: unknown) => void);
    return () => set!.delete(handler as (p: unknown) => void);
  }
  close() {
    this.closed = true;
  }

  emit<E extends keyof AgentTransportEventMap>(
    event: E,
    payload: AgentTransportEventMap[E],
  ) {
    const set = this.#listeners[event];
    if (!set) return;
    for (const h of set) (h as (p: unknown) => void)(payload);
  }
}

describe("Agent with a neutral mock transport", () => {
  beforeEach(() => {
    // Tests share toolRegistry; clear between cases.
    for (const t of toolRegistry.getDeclarations())
      toolRegistry.unregister(t.name);
  });

  it("connects, dispatches a tool call, and replies with the result", async () => {
    toolRegistry.register({
      name: "add_one",
      description: "add 1",
      parameters: { type: "object", properties: {} },
      execute: async (args: Record<string, unknown>) => ({
        result: (args.x as number) + 1,
      }),
    });

    const surfaces: AgentSurface[] = [];
    const transport = new MockAgentTransport();
    const agent = new Agent(
      {
        surfaces: () => surfaces,
        contextInstructions: () => "",
        instructions: "You are a test agent.",
      },
      transport,
    );

    await agent.start();
    flushSync();
    expect(agent.connected).toBe(true);
    expect(transport.connectOpts?.systemInstruction).toContain(
      "You are a test agent.",
    );
    expect(transport.connectOpts?.tools.map((t) => t.name)).toContain(
      "add_one",
    );

    transport.emit("tool-call", {
      calls: [{ id: "c1", name: "add_one", args: { x: 2 } }],
    });
    // Tool dispatch is async (await toolRegistry.execute) — drain the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(transport.toolResults).toEqual([
      { id: "c1", name: "add_one", result: { result: 3 } },
    ]);
    expect(agent.status).toBe("thinking");

    await agent.stop();
    expect(transport.closed).toBe(true);
    expect(agent.connected).toBe(false);
  });

  it("skips surface-watch polling for surfaces opted out via extensions.surfaceWatch=false", async () => {
    vi.useFakeTimers();
    try {
      let json: unknown = { root: "v1" };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [
            {
              id: "main",
              type: "static",
              getJson: () => json,
              extensions: STRICT,
            },
          ],
          contextInstructions: () => "",
          instructions: "persona",
          surfaceWatchTuning: {
            mode: "proactive",
            intervalMs: 1000,
            settleMs: 0,
            cooldownMs: 0,
          },
        },
        transport,
      );

      await agent.start();
      flushSync();

      // Mutate the surface and advance well past the polling interval.
      json = { root: "v2" };
      vi.advanceTimersByTime(5000);
      flushSync();

      expect(
        transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(false);

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("proactive mode emits an extension-wrapped SURFACE_UPDATED text turn for an ALL_EXTRAS surface", async () => {
    vi.useFakeTimers();
    try {
      let json: unknown = { root: "v1" };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [
            {
              id: "main",
              type: "static",
              getJson: () => json,
              extensions: ALL_EXTRAS,
            },
          ],
          contextInstructions: () => "ctx",
          instructions: "persona",
          surfaceWatchTuning: {
            mode: "proactive",
            intervalMs: 1000,
            settleMs: 0,
            cooldownMs: 0,
          },
        },
        transport,
      );

      await agent.start();
      flushSync();

      json = { root: "v2" };
      vi.advanceTimersByTime(1500);
      flushSync();

      const event = transport.textsSent.find((t) =>
        t.includes("SURFACE_UPDATED"),
      );
      expect(event).toBeDefined();
      const match = event!.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
      expect(match).toBeTruthy();
      const parsed = JSON.parse(match![1]);
      expect(parsed.extensions["a2ui-svelte"]).toMatchObject({
        kind: "surfaceUpdated",
        updatedSurfaces: [{ root: "v2" }],
        updatedContext: "ctx",
      });
      expect(
        Array.isArray(parsed.extensions["a2ui-svelte"].availableElementIds),
      ).toBe(true);

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("proactive mode polls dynamic surfaces too, so user input into a path-bound field reaches the agent", async () => {
    vi.useFakeTimers();
    try {
      // Mirrors a dynamic surface the agent rendered (a TextField bound to
      // /draft) that the user then typed into: serializeSurface includes
      // the data model, so the JSON changes when the user writes.
      let json: unknown = { surfaceId: "canvas", data: { draft: "" } };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          mode: "dynamic",
          surfaces: () => [
            {
              id: "canvas",
              type: "dynamic",
              getJson: () => json,
              extensions: ALL_EXTRAS,
            },
          ],
          contextInstructions: () => "",
          instructions: "persona",
          surfaceWatchTuning: {
            mode: "proactive",
            intervalMs: 1000,
            settleMs: 0,
            cooldownMs: 0,
          },
        },
        transport,
      );

      await agent.start();
      flushSync();

      // User types into the field — the data model now reflects it.
      json = { surfaceId: "canvas", data: { draft: "hello" } };
      vi.advanceTimersByTime(1500);
      flushSync();

      const event = transport.textsSent.find((t) =>
        t.includes("SURFACE_UPDATED"),
      );
      expect(event).toBeDefined();
      const match = event!.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
      const parsed = JSON.parse(match![1]);
      expect(parsed.extensions["a2ui-svelte"].updatedSurfaces).toEqual([
        { surfaceId: "canvas", data: { draft: "hello" } },
      ]);

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll a STRICT dynamic surface", async () => {
    vi.useFakeTimers();
    try {
      let json: unknown = { surfaceId: "canvas", data: { draft: "" } };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          mode: "dynamic",
          surfaces: () => [
            {
              id: "canvas",
              type: "dynamic",
              getJson: () => json,
              extensions: STRICT,
            },
          ],
          contextInstructions: () => "",
          instructions: "persona",
          surfaceWatchTuning: {
            mode: "proactive",
            intervalMs: 1000,
            settleMs: 0,
            cooldownMs: 0,
          },
        },
        transport,
      );

      await agent.start();
      flushSync();

      json = { surfaceId: "canvas", data: { draft: "hello" } };
      vi.advanceTimersByTime(5000);
      flushSync();

      expect(
        transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(false);

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a surface with no extensions field as opted-in (back-compat default)", async () => {
    vi.useFakeTimers();
    try {
      let json: unknown = { root: "v1" };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          // Note: no `extensions` field — represents a pre-extension-era
          // hand-rolled surface handle. Must still get polled.
          surfaces: () => [{ id: "main", type: "static", getJson: () => json }],
          contextInstructions: () => "",
          instructions: "persona",
          surfaceWatchTuning: {
            mode: "proactive",
            intervalMs: 1000,
            settleMs: 0,
            cooldownMs: 0,
          },
        },
        transport,
      );

      await agent.start();
      flushSync();

      json = { root: "v2" };
      vi.advanceTimersByTime(1500);
      flushSync();

      expect(
        transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(true);

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("proactive mode debounces an in-flight value and only delivers it once settled", async () => {
    vi.useFakeTimers();
    try {
      let json: unknown = { name: "" };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [
            {
              id: "main",
              type: "static",
              getJson: () => json,
              extensions: ALL_EXTRAS,
            },
          ],
          contextInstructions: () => "",
          instructions: "persona",
          surfaceWatchTuning: {
            mode: "proactive",
            intervalMs: 1000,
            settleMs: 3000,
            cooldownMs: 0,
          },
        },
        transport,
      );

      await agent.start();
      flushSync();

      // User is mid-typing: the value keeps changing tick over tick.
      json = { name: "Joh" };
      vi.advanceTimersByTime(1000);
      json = { name: "John" };
      vi.advanceTimersByTime(1000);
      flushSync();
      // Not stable for settleMs yet → nothing delivered (no half-typed value).
      expect(
        transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(false);

      // User stops typing; let the value settle.
      vi.advanceTimersByTime(3000);
      flushSync();
      const events = transport.textsSent.filter((t) =>
        t.includes("SURFACE_UPDATED"),
      );
      expect(events.length).toBe(1);
      expect(events[0]).toContain('"John"');
      expect(events[0]).not.toContain('"Joh"'); // the in-flight value never shipped

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("sync mode (A2UI v0.9 data-model sync, the default)", () => {
    // A surface whose component STRUCTURE is value-independent (values live in
    // the data model, as with `fieldName`-bound inputs). Mutate `state.dm` to
    // simulate the user typing; mutate `state.struct` to simulate navigation /
    // a component appearing.
    function syncSetup(tuning?: Record<string, unknown>) {
      const state = {
        dm: {} as Record<string, string>,
        struct: {
          surfaceId: "main",
          rootId: "root",
          components: [] as unknown[],
        },
      };
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [
            {
              id: "main",
              type: "static",
              getJson: () => state.struct,
              getDataModel: () => ({ ...state.dm }),
              extensions: ALL_EXTRAS,
            },
          ],
          contextInstructions: () => "ctx",
          instructions: "persona",
          surfaceWatchTuning: tuning as never,
        },
        transport,
      );
      return { state, transport, agent };
    }

    // Parse the extension payload of the most recent silent context update.
    function lastSilentExt(transport: MockAgentTransport): Record<string, any> {
      const msg = transport.contextUpdates[transport.contextUpdates.length - 1];
      const match = msg.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
      return JSON.parse(match![1]).extensions["a2ui-svelte"];
    }

    // Poll cadence that effectively disables timer-driven delivery so a test can
    // isolate the explicit-flush paths (turn-complete / typed message / action).
    const NO_POLL = {
      mode: "sync",
      intervalMs: 1_000_000,
      settleMs: 1_000_000,
    };

    it("does NOT deliver at the inbound transcript (the old barge-in root cause)", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      await agent.start();
      flushSync();

      // User typed while idle, then a fresh inbound turn arrives.
      state.dm = { name: "Mario" };
      transport.emit("text-in", { text: "what did I type?" });
      flushSync();

      // Nothing is sent at the inbound-transcript moment — that would interrupt
      // the answer. Sync happens in idle windows (turn-complete / settle tick /
      // pre-message).
      expect(transport.contextUpdates.length).toBe(0);
      expect(
        transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(false);

      await agent.stop();
    });

    it("buffers an edit made while the model generates and flushes it (delta) at turn-complete", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      // Both fields are empty at connect time, so that baseline is already known
      // to the model (it's in the system prompt).
      state.dm = { name: "", role: "" };
      await agent.start();
      flushSync();

      // Model is generating (a `text-out` chunk sets `modelTurnActive`).
      transport.emit("text-out", { text: "working on it" });
      // User fills only the name field mid-answer; `role` stays empty.
      state.dm = { name: "Mario", role: "" };
      flushSync();
      // Gated — must not interrupt the in-progress answer.
      expect(transport.contextUpdates.length).toBe(0);

      // Model goes idle → the buffered change flushes immediately.
      transport.emit("turn-complete", {} as never);
      flushSync();
      expect(transport.contextUpdates.length).toBe(1);

      const ext = lastSilentExt(transport);
      expect(ext.kind).toBe("clientDataModel");
      expect(ext.delta).toBe(true);
      // Only the CHANGED key — the unchanged empty `role` is not re-sent.
      expect(ext.surfaces).toEqual({ main: { name: "Mario" } });

      await agent.stop();
    });

    it("coalesces multiple edits during the model turn into a single final-value delivery", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      await agent.start();
      flushSync();

      transport.emit("text-out", { text: "thinking" });
      state.dm = { name: "Luigi" };
      flushSync();
      state.dm = { name: "Mario" };
      flushSync();
      expect(transport.contextUpdates.length).toBe(0);

      transport.emit("turn-complete", {} as never);
      flushSync();
      expect(transport.contextUpdates.length).toBe(1);
      const ext = lastSilentExt(transport);
      expect(ext.surfaces).toEqual({ main: { name: "Mario" } });
      // The intermediate value never shipped.
      expect(transport.contextUpdates[0]).not.toContain("Luigi");

      await agent.stop();
    });

    it("sends a full surfaceUpdated re-sync when the structure changes (navigation)", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      await agent.start();
      flushSync();

      // A new component appears (structure, not just a value).
      state.struct = {
        surfaceId: "main",
        rootId: "root",
        components: [{ id: "b", component: { Button: {} } }] as unknown[],
      };
      agent.sendTextMessage("what changed?");
      flushSync();

      expect(transport.contextUpdates.length).toBe(1);
      const ext = lastSilentExt(transport);
      expect(ext.kind).toBe("surfaceUpdated");
      expect(ext.updatedSurfaces).toEqual([state.struct]);
      expect(Array.isArray(ext.availableElementIds)).toBe(true);

      await agent.stop();
    });

    it("syncs the data-model delta before a typed message", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      await agent.start();
      flushSync();

      state.dm = { name: "Mario" };
      agent.sendTextMessage("who did I add?");
      flushSync();

      expect(transport.contextUpdates.length).toBe(1);
      expect(lastSilentExt(transport).surfaces).toEqual({
        main: { name: "Mario" },
      });
      expect(transport.textsSent).toContain("who did I add?");

      await agent.stop();
    });

    it("syncs the data-model delta before a userAction (button click)", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      await agent.start();
      flushSync();

      state.dm = { name: "Mario" };
      userActionBus.emit({
        name: "save",
        surfaceId: "main",
        sourceComponentId: "save-btn",
        timestamp: "2026-05-31T00:00:00.000Z",
        context: {},
      });
      flushSync();

      expect(transport.contextUpdates.length).toBe(1);
      expect(lastSilentExt(transport).surfaces).toEqual({
        main: { name: "Mario" },
      });
      expect(transport.textsSent.some((t) => t.includes("USER_ACTION"))).toBe(
        true,
      );

      await agent.stop();
    });

    it("does not flush when nothing changed since the model last saw it", async () => {
      const { transport, agent } = syncSetup(NO_POLL);
      await agent.start();
      flushSync();

      agent.sendTextMessage("hello");
      flushSync();
      expect(transport.contextUpdates.length).toBe(0);

      await agent.stop();
    });

    it("does not echo the agent's own tool-call write back to it", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      // A backend-style tool that mutates the surface's data model.
      toolRegistry.register({
        name: "set_name",
        description: "set the name",
        parameters: { type: "object", properties: {} },
        execute: async (args: Record<string, unknown>) => {
          state.dm = { name: args.value as string };
          return { status: "success" };
        },
      });
      await agent.start();
      flushSync();

      transport.emit("tool-call", {
        calls: [{ id: "c1", name: "set_name", args: { value: "Mario" } }],
      });
      await new Promise((r) => setTimeout(r, 0));
      flushSync();

      // The agent already knows it wrote `name: Mario`; a later flush must not
      // re-report it.
      agent.sendTextMessage("done?");
      flushSync();
      expect(transport.contextUpdates.length).toBe(0);

      await agent.stop();
    });

    it("falls back to a text turn when the transport has no silent context channel", async () => {
      const { state, transport, agent } = syncSetup(NO_POLL);
      (
        transport as unknown as { sendContextUpdate?: unknown }
      ).sendContextUpdate = undefined;
      await agent.start();
      flushSync();

      state.dm = { name: "Mario" };
      agent.sendTextMessage("x");
      flushSync();

      expect(
        transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(true);

      await agent.stop();
    });

    it("delivers a settled change on the idle poll tick — no spoken turn needed", async () => {
      vi.useFakeTimers();
      try {
        const { state, transport, agent } = syncSetup({
          mode: "sync",
          intervalMs: 100,
          settleMs: 300,
        });
        await agent.start();
        flushSync();

        state.dm = { name: "Mario" };
        vi.advanceTimersByTime(150);
        flushSync();
        // Not stable for settleMs yet.
        expect(transport.contextUpdates.length).toBe(0);

        vi.advanceTimersByTime(400);
        flushSync();
        expect(transport.contextUpdates.length).toBe(1);
        const ext = lastSilentExt(transport);
        expect(ext.kind).toBe("clientDataModel");
        expect(ext.surfaces).toEqual({ main: { name: "Mario" } });

        await agent.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never delivers on a poll tick while the model is generating", async () => {
      vi.useFakeTimers();
      try {
        const { state, transport, agent } = syncSetup({
          mode: "sync",
          intervalMs: 100,
          settleMs: 0,
        });
        await agent.start();
        flushSync();

        transport.emit("text-out", { text: "generating" });
        state.dm = { name: "Mario" };
        vi.advanceTimersByTime(1000);
        flushSync();
        expect(transport.contextUpdates.length).toBe(0);

        // Once the model goes idle the buffered change flushes.
        transport.emit("turn-complete", {} as never);
        flushSync();
        expect(transport.contextUpdates.length).toBe(1);

        await agent.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never delivers on a poll tick while the model is thinking (post-input, pre-output window)", async () => {
      vi.useFakeTimers();
      try {
        const { state, transport, agent } = syncSetup({
          mode: "sync",
          intervalMs: 100,
          settleMs: 0,
        });
        await agent.start();
        flushSync();

        // The user finished their turn: status is 'thinking', but the model
        // hasn't started its output yet so `modelTurnActive` is still false.
        // This is the window the old `modelTurnActive`-only gate missed —
        // a poll-driven sendContextUpdate here barges into the forming answer.
        transport.emit("text-in", { text: "what did I type?" });
        state.dm = { name: "Mario" };
        vi.advanceTimersByTime(1000);
        flushSync();
        expect(transport.contextUpdates.length).toBe(0);

        // The model answers and the turn ends → the buffered change flushes.
        transport.emit("turn-complete", {} as never);
        flushSync();
        expect(transport.contextUpdates.length).toBe(1);
        expect(lastSilentExt(transport).surfaces).toEqual({
          main: { name: "Mario" },
        });

        await agent.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not echo the agent's own dynamic render (surfaceUpdate + beginRendering) back to it", async () => {
      const surfaceId = "echo-canvas";
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          mode: "dynamic",
          surfaces: () => [
            {
              id: surfaceId,
              type: "dynamic",
              getJson: () => serializeSurface(surfaceId) ?? { surfaceId },
              getDataModel: () => ({
                ...(a2uiState.getSurface(surfaceId)?.data ?? {}),
              }),
              extensions: ALL_EXTRAS,
            },
          ],
          contextInstructions: () => "",
          instructions: "persona",
          surfaceWatchTuning: NO_POLL as never,
        },
        transport,
      );

      await agent.start();
      flushSync();

      // The agent renders a button on the canvas — its own write.
      transport.emit("tool-call", {
        calls: [
          {
            id: "c1",
            name: "surfaceUpdate",
            args: {
              surfaceId,
              components: [{ id: "b", component: { Button: { label: "Yes" } } }],
            },
          },
          { id: "c2", name: "beginRendering", args: { surfaceId, root: "b" } },
        ],
      });
      await new Promise((r) => setTimeout(r, 0));
      flushSync();

      // A later idle flush must NOT re-send the structure the agent just
      // authored back to it as a SURFACE_UPDATED re-sync.
      agent.sendTextMessage("done?");
      flushSync();
      expect(
        transport.contextUpdates.some((t) => t.includes("SURFACE_UPDATED")),
      ).toBe(false);

      a2uiState.deleteSurface(surfaceId);
      await agent.stop();
    });

    it("defaults to sync mode when no surfaceWatchTuning is given", async () => {
      vi.useFakeTimers();
      try {
        const { state, transport, agent } = syncSetup(undefined);
        await agent.start();
        flushSync();

        state.dm = { name: "Mario" };
        vi.advanceTimersByTime(1500);
        flushSync();

        expect(transport.contextUpdates.length).toBe(1);
        expect(lastSilentExt(transport).kind).toBe("clientDataModel");

        await agent.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats the deprecated "piggyback" mode as an alias for "sync"', async () => {
      vi.useFakeTimers();
      try {
        const { state, transport, agent } = syncSetup({
          mode: "piggyback",
          intervalMs: 100,
          settleMs: 0,
        });
        await agent.start();
        flushSync();

        state.dm = { name: "Mario" };
        vi.advanceTimersByTime(300);
        flushSync();

        expect(transport.contextUpdates.length).toBe(1);
        expect(lastSilentExt(transport).kind).toBe("clientDataModel");

        await agent.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("B5: falls back to wrapped text turn for userAction when transport has no sendUserAction", async () => {
    const transport = new MockAgentTransport();
    const agent = new Agent(
      {
        surfaces: () => [],
        contextInstructions: () => "",
        instructions: "persona",
      },
      transport,
    );

    await agent.start();
    flushSync();

    const action: UserAction = {
      name: "submit",
      surfaceId: "main",
      sourceComponentId: "save-btn",
      timestamp: "2026-05-27T00:00:00.000Z",
      context: {},
    };
    userActionBus.emit(action);

    const ev = transport.textsSent.find((t) => t.includes("USER_ACTION"));
    expect(ev).toBeDefined();
    const match = ev!.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
    expect(match).toBeTruthy();
    const parsed = JSON.parse(match![1]);
    expect(parsed).toEqual({
      userAction: {
        name: "submit",
        surfaceId: "main",
        sourceComponentId: "save-btn",
        timestamp: "2026-05-27T00:00:00.000Z",
        context: {},
      },
    });

    await agent.stop();
  });

  it("B5: forwards userAction via sendUserAction when the transport implements it", async () => {
    const received: UserAction[] = [];
    const transport = new MockAgentTransport();
    (transport as AgentTransport).sendUserAction = (a: UserAction) =>
      received.push(a);

    const agent = new Agent(
      {
        surfaces: () => [],
        contextInstructions: () => "",
        instructions: "persona",
      },
      transport,
    );

    await agent.start();
    flushSync();

    const action: UserAction = {
      name: "submit",
      surfaceId: "main",
      sourceComponentId: "save-btn",
      timestamp: "2026-05-27T00:00:00.000Z",
      context: { who: "dario" },
    };
    userActionBus.emit(action);

    expect(received).toEqual([action]);
    // Crucially: it must NOT also send a wrapped text turn.
    expect(transport.textsSent.some((t) => t.includes("USER_ACTION"))).toBe(
      false,
    );

    await agent.stop();
  });

  it("B5: defaults a missing context to {} so the emitted action is spec-conformant", async () => {
    const received: UserAction[] = [];
    const transport = new MockAgentTransport();
    (transport as AgentTransport).sendUserAction = (a: UserAction) =>
      received.push(a);

    const agent = new Agent(
      {
        surfaces: () => [],
        contextInstructions: () => "",
        instructions: "persona",
      },
      transport,
    );

    await agent.start();
    flushSync();

    // Simulate a hand-rolled emitter that forgot the context field.
    userActionBus.emit({
      name: "submit",
      surfaceId: "main",
      sourceComponentId: "save-btn",
      timestamp: "2026-05-27T00:00:00.000Z",
      context: undefined as unknown as Record<string, unknown>,
    });

    expect(received[0].context).toEqual({});

    await agent.stop();
  });

  it("captures text-in / text-out and clears thinking on turn-complete", async () => {
    const transport = new MockAgentTransport();
    const agent = new Agent(
      {
        surfaces: () => [],
        contextInstructions: () => "",
        instructions: "persona",
      },
      transport,
    );

    await agent.start();
    flushSync();

    transport.emit("text-in", { text: "hello" });
    flushSync();
    transport.emit("text-out", { text: "hi back" });
    transport.emit("turn-complete", {} as never);
    flushSync();

    expect(agent.transcript[0]).toEqual({ role: "user", text: "hello" });
    expect(agent.transcript[1]).toEqual({ role: "model", text: "hi back" });
    expect(agent.status).toBe("idle");

    await agent.stop();
  });

  it("starts a new user turn after turn-complete even when the model produced no text (tool-only turn)", async () => {
    const transport = new MockAgentTransport();
    const agent = new Agent(
      {
        surfaces: () => [],
        contextInstructions: () => "",
        instructions: "persona",
      },
      transport,
    );

    await agent.start();
    flushSync();

    // First utterance, then a tool-only turn (no text-out at all, as in
    // dynamic-surface renders) that simply completes.
    transport.emit("text-in", { text: "first" });
    transport.emit("turn-complete", {} as never);
    flushSync();

    // The next utterance must be its own turn — not appended to the first.
    transport.emit("text-in", { text: "second" });
    flushSync();

    const userTurns = agent.transcript.filter((m) => m.role === "user");
    expect(userTurns.map((m) => m.text)).toEqual(["first", "second"]);

    await agent.stop();
  });

  it("self-heals a stuck 'thinking' badge after the watchdog window when no response arrives", async () => {
    vi.useFakeTimers();
    try {
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
        },
        transport,
      );

      await agent.start();
      flushSync();

      // The user speaks; a response is now expected.
      transport.emit("text-in", { text: "hello?" });
      flushSync();
      expect(agent.status).toBe("thinking");

      // ...but the turn is dropped: no audio / transcript / turn-complete ever
      // arrives. The badge must not spin forever.
      vi.advanceTimersByTime(12_000);
      flushSync();
      expect(agent.status).toBe("idle");

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps 'thinking' while the model is actively producing tool calls (watchdog re-arms)", async () => {
    vi.useFakeTimers();
    try {
      toolRegistry.register({
        name: "noop",
        description: "no-op",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ status: "success" }),
      });
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
        },
        transport,
      );

      await agent.start();
      flushSync();

      transport.emit("text-in", { text: "do some work" });
      flushSync();

      // A tool call lands every few seconds — each is model activity that
      // re-arms the watchdog, so the badge stays accurate (not prematurely
      // cleared) across a multi-step turn that never speaks.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(8_000);
        transport.emit("tool-call", {
          calls: [{ id: `c${i}`, name: "noop", args: {} }],
        });
        await Promise.resolve();
        flushSync();
        expect(agent.status).toBe("thinking");
      }

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("history routing by capability", () => {
    it("embeds prior turns in the prompt for a server-history transport", async () => {
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
        },
        transport,
      );

      // Seed a prior turn, then connect a fresh session.
      agent.transcript = [{ role: "user", text: "remember this" }];
      await agent.start();
      flushSync();

      // Server-history (voice profile): history rides in the system prompt, not
      // the connect `history` option.
      expect(transport.connectOpts?.systemInstruction).toContain(
        "remember this",
      );
      expect(transport.connectOpts?.history).toBeUndefined();

      await agent.stop();
    });

    it("seeds prior turns via connect options for a client-history transport", async () => {
      const transport = new MockAgentTransport();
      // Override to a client-history (text) profile.
      Object.defineProperty(transport, "capabilities", {
        get: (): TransportCapabilities => ({
          streaming: false,
          interruptible: false,
          silentContext: false,
          historyOwnership: "client",
          canInitiateTurn: false,
          input: ["text"],
          output: ["text"],
        }),
      });
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
        },
        transport,
      );

      agent.transcript = [{ role: "user", text: "remember this" }];
      await agent.start();
      flushSync();

      // Client-history: the prompt omits the history block; prior turns are
      // seeded through the connect `history` option instead.
      expect(transport.connectOpts?.systemInstruction).not.toContain(
        "remember this",
      );
      expect(transport.connectOpts?.history).toEqual([
        { role: "user", text: "remember this" },
      ]);

      await agent.stop();
    });
  });

  describe("non-streaming (request/response) transport", () => {
    function textProfile(): TransportCapabilities {
      return {
        streaming: false,
        interruptible: false,
        silentContext: false,
        historyOwnership: "client",
        canInitiateTurn: false,
        input: ["text"],
        output: ["text"],
      };
    }

    it("runs no poll loop but still flushes the surface before a typed message", async () => {
      vi.useFakeTimers();
      try {
        const state = { dm: {} as Record<string, string> };
        const transport = new MockAgentTransport();
        Object.defineProperty(transport, "capabilities", {
          get: textProfile,
        });
        // A non-streaming transport has no silent channel → it falls back to a
        // text turn for the pre-message surface flush.
        (
          transport as unknown as { sendContextUpdate?: unknown }
        ).sendContextUpdate = undefined;
        const agent = new Agent(
          {
            surfaces: () => [
              {
                id: "main",
                type: "static",
                getJson: () => ({ surfaceId: "main" }),
                getDataModel: () => ({ ...state.dm }),
                extensions: ALL_EXTRAS,
              },
            ],
            contextInstructions: () => "ctx",
            instructions: "persona",
            // Even a fast poll cadence must not start a timer on a non-streaming
            // transport.
            surfaceWatchTuning: { mode: "sync", intervalMs: 1, settleMs: 0 },
          },
          transport,
        );

        await agent.start();
        flushSync();

        // The user typed; then advance time well past the poll interval. No
        // timer is running, so nothing is delivered until the typed message.
        state.dm = { name: "Mario" };
        vi.advanceTimersByTime(1000);
        flushSync();
        expect(
          transport.textsSent.some((t) => t.includes("SURFACE_UPDATED")),
        ).toBe(false);

        // The pre-turn flush attaches the current UI to the typed message.
        agent.sendTextMessage("who did I add?");
        flushSync();
        const surfaceTurn = transport.textsSent.find((t) =>
          t.includes("SURFACE_UPDATED"),
        );
        expect(surfaceTurn).toBeDefined();
        expect(surfaceTurn).toContain("Mario");
        expect(transport.textsSent).toContain("who did I add?");

        await agent.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes the surface even while the model is mid-generation (no barge-in to fear)", async () => {
      const state = { dm: {} as Record<string, string> };
      const transport = new MockAgentTransport();
      Object.defineProperty(transport, "capabilities", { get: textProfile });
      // A non-streaming transport has no silent channel → the flush rides a
      // normal text turn.
      (
        transport as unknown as { sendContextUpdate?: unknown }
      ).sendContextUpdate = undefined;
      const agent = new Agent(
        {
          surfaces: () => [
            {
              id: "main",
              type: "static",
              getJson: () => ({ surfaceId: "main" }),
              getDataModel: () => ({ ...state.dm }),
              extensions: ALL_EXTRAS,
            },
          ],
          contextInstructions: () => "ctx",
          instructions: "persona",
          surfaceWatchTuning: { mode: "sync", intervalMs: 1_000_000, settleMs: 0 },
        },
        transport,
      );

      await agent.start();
      flushSync();

      // Model "generating" — on an interruptible transport this would gate the
      // flush, but a request/response transport has nothing to interrupt.
      transport.emit("text-out", { text: "partial answer" });
      state.dm = { name: "Mario" };
      agent.sendTextMessage("and now?");
      flushSync();

      const surfaceTurn = transport.textsSent.find((t) =>
        t.includes("SURFACE_UPDATED"),
      );
      expect(surfaceTurn).toBeDefined();
      expect(surfaceTurn).toContain("Mario");

      await agent.stop();
    });

    it("downgrades 'proactive' to 'sync' when the transport can't initiate turns", async () => {
      const transport = new MockAgentTransport();
      Object.defineProperty(transport, "capabilities", { get: textProfile });
      (
        transport as unknown as { sendContextUpdate?: unknown }
      ).sendContextUpdate = undefined;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const state = { dm: {} as Record<string, string> };
        const agent = new Agent(
          {
            surfaces: () => [
              {
                id: "main",
                type: "static",
                getJson: () => ({ surfaceId: "main" }),
                getDataModel: () => ({ ...state.dm }),
                extensions: ALL_EXTRAS,
              },
            ],
            contextInstructions: () => "",
            instructions: "persona",
            surfaceWatchTuning: { mode: "proactive", settleMs: 0 },
          },
          transport,
        );
        expect(warn).toHaveBeenCalled();

        await agent.start();
        flushSync();

        // It behaves as 'sync': the pre-message flush emits a clientDataModel
        // delta, never a turn-triggering proactive push.
        state.dm = { name: "Mario" };
        agent.sendTextMessage("hi");
        flushSync();
        const surfaceTurn = transport.textsSent.find((t) =>
          t.includes("SURFACE_UPDATED"),
        );
        expect(surfaceTurn).toBeDefined();
        expect(surfaceTurn).toContain("clientDataModel");

        await agent.stop();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("debug telemetry", () => {
    it("records the system-prompt and tools payload sizes at connect", async () => {
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "You are a test agent.",
        },
        transport,
      );

      await agent.start();
      flushSync();

      const sp = agent.debug.outbound["system-prompt"];
      const sent = transport.connectOpts!.systemInstruction;
      expect(sp.count).toBe(1);
      expect(sp.bytes).toBe(new TextEncoder().encode(sent).length);
      expect(sp.estTokens).toBeGreaterThan(0);
      expect(agent.debug.toolCount).toBe(transport.connectOpts!.tools.length);

      await agent.stop();
    });

    it("sizes the tool-result echo — the full-surface payload that drives the quota cost", async () => {
      // A tool whose result carries a large `updatedSurface` echo, exactly like
      // the `toolResultExtras` extension does on a dense static surface.
      const bigSurface = Array.from({ length: 200 }, (_, i) => ({
        id: `field-${i}`,
        component: { DateTimeInput: { value: { path: `/field-${i}` } } },
      }));
      toolRegistry.register({
        name: "update_text_fields",
        description: "batch update",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          results: [{ element_id: "field-0", status: "success" }],
          extensions: { "a2ui-svelte": { updatedSurface: [bigSurface] } },
        }),
      });
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
        },
        transport,
      );

      await agent.start();
      flushSync();

      transport.emit("tool-call", {
        calls: [{ id: "c1", name: "update_text_fields", args: {} }],
      });
      await new Promise((r) => setTimeout(r, 0));
      flushSync();

      const tr = agent.debug.outbound["tool-result"];
      const expectedBytes = JSON.stringify(transport.toolResults[0].result).length;
      expect(tr.count).toBe(1);
      expect(tr.bytes).toBe(expectedBytes);
      expect(tr.estTokens).toBeGreaterThan(0);
      // The echo is the dominant per-call cost — assert it's substantial here.
      expect(tr.bytes).toBeGreaterThan(5000);
      expect(agent.debug.events.at(-1)).toMatchObject({
        kind: "tool-result",
        note: "update_text_fields",
      });

      await agent.stop();
    });

    it("folds the provider's authoritative usage from the transport 'usage' event", async () => {
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
        },
        transport,
      );

      await agent.start();
      flushSync();

      transport.emit("usage", {
        promptTokenCount: 61432,
        responseTokenCount: 280,
        totalTokenCount: 61712,
        details: [{ modality: "TEXT", tokenCount: 61432 }],
      });
      flushSync();

      expect(agent.debug.usage.last?.totalTokenCount).toBe(61712);
      expect(agent.debug.usage.peakTotal).toBe(61712);
      expect(agent.debug.usage.reports).toBe(1);

      await agent.stop();
    });

    it("records nothing when debug is disabled", async () => {
      const transport = new MockAgentTransport();
      const agent = new Agent(
        {
          surfaces: () => [],
          contextInstructions: () => "",
          instructions: "persona",
          debug: false,
        },
        transport,
      );

      await agent.start();
      flushSync();
      transport.emit("usage", { totalTokenCount: 1000 });
      flushSync();

      expect(agent.debug.outbound["system-prompt"].count).toBe(0);
      expect(agent.debug.usage.reports).toBe(0);

      await agent.stop();
    });
  });
});

// The same Agent class drives the audio surface — gated purely on the
// transport's capabilities. These cases were the old VoiceAgent suite.
class MockAudioTransport extends MockAgentTransport {
  audioSent: string[] = [];

  override get capabilities(): TransportCapabilities {
    return {
      streaming: true,
      interruptible: true,
      silentContext: true,
      historyOwnership: "server",
      canInitiateTurn: true,
      input: ["audio", "text"],
      output: ["audio", "text"],
    };
  }

  sendAudioChunk(b64: string) {
    this.audioSent.push(b64);
  }
}

describe("Agent audio surface (capability-gated)", () => {
  beforeEach(() => {
    for (const t of toolRegistry.getDeclarations())
      toolRegistry.unregister(t.name);
    recorderHolder.last = null;
    playerHolder.last = null;
  });

  it("starts no recorder or player on a text-only transport", async () => {
    const transport = new MockAgentTransport();
    const agent = new Agent(
      {
        instructions: "persona",
        surfaces: () => [],
      },
      transport,
    );

    await agent.start();
    flushSync();
    expect(agent.connected).toBe(true);
    expect(agent.recording).toBe(false);
    expect(recorderHolder.last).toBeNull();
    expect(playerHolder.last).toBeNull();

    await agent.stop();
  });

  it("drops captured audio while muted, resumes on unmute, and keeps the session open", async () => {
    const transport = new MockAudioTransport();
    const agent = new Agent(
      {
        instructions: "persona",
        surfaces: () => [],
      },
      transport,
    );

    await agent.start();
    flushSync();
    expect(agent.muted).toBe(false);
    expect(agent.recording).toBe(true);

    const emitChunk = (b64: string) =>
      recorderHolder.last!.dispatchEvent(
        new CustomEvent("data", { detail: b64 }),
      );

    // Unmuted: audio reaches the transport.
    emitChunk("live-1");
    expect(transport.audioSent).toEqual(["live-1"]);

    // Muted: the chunk is dropped, but the session stays connected.
    agent.toggleMute();
    flushSync();
    expect(agent.muted).toBe(true);
    emitChunk("muted-1");
    expect(transport.audioSent).toEqual(["live-1"]);
    expect(agent.connected).toBe(true);

    // Unmuted again: audio flows once more.
    agent.toggleMute();
    flushSync();
    expect(agent.muted).toBe(false);
    emitChunk("live-2");
    expect(transport.audioSent).toEqual(["live-1", "live-2"]);

    await agent.stop();
    expect(agent.recording).toBe(false);
  });

  it("queues inbound audio for playback and gates a sync flush until turn-complete (barge-in)", async () => {
    vi.useFakeTimers();
    try {
      const state = { dm: {} as Record<string, string> };
      const transport = new MockAudioTransport();
      const agent = new Agent(
        {
          instructions: "persona",
          surfaces: () => [
            {
              id: "main",
              type: "static",
              getJson: () => ({ surfaceId: "main" }),
              getDataModel: () => ({ ...state.dm }),
              extensions: ALL_EXTRAS,
            },
          ] satisfies AgentSurface[],
          contextInstructions: () => "ctx",
          surfaceWatchTuning: { mode: "sync", intervalMs: 100, settleMs: 0 },
        },
        transport,
      );

      await agent.start();
      flushSync();

      // Inbound audio: queued to the player AND marks the model generating.
      transport.emit("audio-out", { base64Pcm24k: "AAA" });
      expect(playerHolder.last!.addToQueue).toHaveBeenCalledWith("AAA");

      // The user edits mid-answer; the poll tick must NOT deliver (would
      // barge-in-interrupt the spoken answer).
      state.dm = { name: "Mario" };
      vi.advanceTimersByTime(500);
      flushSync();
      expect(transport.contextUpdates.length).toBe(0);

      // Turn ends → the gate clears and the buffered change flushes.
      transport.emit("turn-complete", {} as never);
      flushSync();
      expect(transport.contextUpdates.length).toBe(1);

      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("on interruption stops playback and returns to 'thinking'", async () => {
    const transport = new MockAudioTransport();
    const agent = new Agent(
      {
        instructions: "persona",
        surfaces: () => [],
      },
      transport,
    );

    await agent.start();
    flushSync();

    transport.emit("audio-out", { base64Pcm24k: "AAA" });
    transport.emit("interrupted", {} as never);
    flushSync();

    expect(playerHolder.last!.stop).toHaveBeenCalled();
    expect(agent.status).toBe("thinking");

    await agent.stop();
  });
});
