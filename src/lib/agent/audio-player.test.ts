import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioPlayer } from './audio-player';

// jsdom has no Web Audio. Sources end only when a test calls `end()`.
class FakeSource {
	buffer: unknown = null;
	onended: (() => void) | null = null;
	connect() {}
	start() {}
	stop() {
		this.end();
	}
	end() {
		this.onended?.();
	}
}

let sources: FakeSource[] = [];

class FakeAudioContext {
	currentTime = 0;
	state = 'running';
	destination = {};
	resume() {
		return Promise.resolve();
	}
	createBuffer(_channels: number, length: number, rate: number) {
		const data = new Float32Array(length);
		return { duration: length / rate, getChannelData: () => data };
	}
	createBufferSource() {
		const s = new FakeSource();
		sources.push(s);
		return s;
	}
}

const CHUNK = 'AAAA'; // 3 bytes → one 16-bit sample

describe('AudioPlayer playing state', () => {
	beforeEach(() => {
		sources = [];
		vi.stubGlobal('AudioContext', FakeAudioContext);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reports playing from the first scheduled chunk until the last one ends', () => {
		const changes: boolean[] = [];
		const player = new AudioPlayer(24000, (p) => changes.push(p));

		// The first 4 chunks are held as a jitter buffer before anything plays.
		for (let i = 0; i < 3; i++) player.addToQueue(CHUNK);
		expect(changes).toEqual([]);
		player.addToQueue(CHUNK);
		player.addToQueue(CHUNK);
		expect(changes).toEqual([true]);

		sources.slice(0, 4).forEach((s) => s.end());
		expect(changes).toEqual([true]);
		sources[4].end();
		expect(changes).toEqual([true, false]);
	});

	it('reports not playing on stop()', () => {
		const changes: boolean[] = [];
		const player = new AudioPlayer(24000, (p) => changes.push(p));

		for (let i = 0; i < 4; i++) player.addToQueue(CHUNK);
		player.stop();
		expect(changes).toEqual([true, false]);
	});
});
