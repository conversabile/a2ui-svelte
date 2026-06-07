import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushSync } from "svelte";
import { VoiceAgent, type VoiceAgentSurface } from "./agent.svelte";
import type {
  VoiceTransport,
  VoiceTransportConnectOptions,
  VoiceTransportEventMap,
} from "./transport";
import type { TransportCapabilities } from "../agent/transport";
import { toolRegistry } from "../core/registries/tool-registry";
import { ALL_EXTRAS } from "../core/extensions";

// The channel-neutral orchestration (tool dispatch, surface-sync, user-actions,
// watchdog, debug, history routing) is exercised in `../agent/agent.test.ts`
// against a neutral transport. This file covers only what `VoiceAgent` *adds*:
// the mic recorder + speaker player, the `muted` toggle, and the audio-only
// transport events (`audio-out` / `interrupted`).

// Stub AudioRecorder/AudioPlayer so the test never touches Web Audio. Each holder
// captures its latest instance so a test can drive a 'data' event (assert what
// reaches the transport, e.g. mute drops it) or spy on the player.
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

class MockTransport implements VoiceTransport {
  connectOpts: VoiceTransportConnectOptions | null = null;
  textsSent: string[] = [];
  contextUpdates: string[] = [];
  audioSent: string[] = [];
  toolResults: Array<{ id: string; name: string; result: unknown }> = [];
  closed = false;

  // Voice-profile capabilities — the same gated paths the real GeminiTransport
  // exercises (barge-in, poll loop, server-held history, proactive turns).
  get capabilities(): TransportCapabilities {
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

  #listeners: {
    [E in keyof VoiceTransportEventMap]?: Set<(p: unknown) => void>;
  } = {};

  async connect(opts: VoiceTransportConnectOptions) {
    this.connectOpts = opts;
  }
  sendAudioChunk(b64: string) {
    this.audioSent.push(b64);
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
  on<E extends keyof VoiceTransportEventMap>(
    event: E,
    handler: (p: VoiceTransportEventMap[E]) => void,
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

  emit<E extends keyof VoiceTransportEventMap>(
    event: E,
    payload: VoiceTransportEventMap[E],
  ) {
    const set = this.#listeners[event];
    if (!set) return;
    for (const h of set) (h as (p: unknown) => void)(payload);
  }
}

describe("VoiceAgent audio surface", () => {
  beforeEach(() => {
    for (const t of toolRegistry.getDeclarations())
      toolRegistry.unregister(t.name);
  });

  it("passes the configured voice name through on connect", async () => {
    const transport = new MockTransport();
    const agent = new VoiceAgent({
      transport,
      surfaces: () => [],
      contextInstructions: () => "",
      systemInstruction: "persona",
      mintToken: async () => "fake",
      voice: "Charon",
    });

    await agent.start();
    flushSync();
    expect(agent.connected).toBe(true);
    expect(transport.connectOpts?.voice).toBe("Charon");

    await agent.stop();
  });

  it("drops captured audio while muted, resumes on unmute, and keeps the session open", async () => {
    const transport = new MockTransport();
    const agent = new VoiceAgent({
      transport,
      surfaces: () => [],
      contextInstructions: () => "",
      systemInstruction: "persona",
      mintToken: async () => "fake",
    });

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
      const transport = new MockTransport();
      const agent = new VoiceAgent({
        transport,
        surfaces: () => [
          {
            id: "main",
            type: "static",
            getJson: () => ({ surfaceId: "main" }),
            getDataModel: () => ({ ...state.dm }),
            extensions: ALL_EXTRAS,
          },
        ] satisfies VoiceAgentSurface[],
        contextInstructions: () => "ctx",
        systemInstruction: "persona",
        mintToken: async () => "fake",
        surfaceWatchTuning: { mode: "sync", intervalMs: 100, settleMs: 0 },
      });

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
    const transport = new MockTransport();
    const agent = new VoiceAgent({
      transport,
      surfaces: () => [],
      contextInstructions: () => "",
      systemInstruction: "persona",
      mintToken: async () => "fake",
    });

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
