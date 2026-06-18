import { describe, it, expect } from 'vitest';
import {
	base64ToBytes,
	base64ToInt16,
	bytesToBase64,
	downmixToMono,
	int16ToBase64,
	resamplePcm16,
	wavToPcm16
} from './pcm';

/** Build a minimal 16-bit PCM WAV file around the given samples. */
function makeWav(samples: Int16Array, sampleRate: number, channels: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);
	const tag = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
	};
	tag(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	tag(36, 'data');
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
	return bytes;
}

describe('pcm helpers', () => {
	it('round-trips bytes and 16-bit samples through base64', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 255]);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);

		const samples = new Int16Array([0, 1, -1, 32767, -32768]);
		expect(base64ToInt16(int16ToBase64(samples))).toEqual(samples);
	});

	it('resamples 16 kHz → 24 kHz at a 3:2 length ratio', () => {
		const input = new Int16Array([0, 1000, 2000, 3000]);
		const out = resamplePcm16(input, 16000, 24000);
		expect(out.length).toBe(6);
		// Endpoints are preserved; interior is interpolated monotonically.
		expect(out[0]).toBe(0);
		expect(out[5]).toBe(3000);
		for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
	});

	it('halves the rate exactly on 48 kHz → 24 kHz', () => {
		const input = new Int16Array(96); // 2ms at 48kHz
		const out = resamplePcm16(input, 48000, 24000);
		expect(out.length).toBe(48);
	});

	it('is a no-op when rates match', () => {
		const input = new Int16Array([1, 2, 3]);
		expect(resamplePcm16(input, 24000, 24000)).toBe(input);
	});

	it('downmixes interleaved stereo by averaging', () => {
		const stereo = new Int16Array([100, 300, -100, -300]);
		expect(downmixToMono(stereo, 2)).toEqual(new Int16Array([200, -200]));
		const mono = new Int16Array([5, 6]);
		expect(downmixToMono(mono, 1)).toBe(mono);
	});

	it('parses a 16-bit PCM WAV container', () => {
		const samples = new Int16Array([10, -10, 20000, -20000]);
		const wav = wavToPcm16(makeWav(samples, 48000, 1));
		expect(wav.sampleRate).toBe(48000);
		expect(wav.channels).toBe(1);
		expect(wav.samples).toEqual(samples);
	});

	it('rejects non-WAV bytes', () => {
		expect(() => wavToPcm16(new Uint8Array([1, 2, 3, 4]))).toThrow(/RIFF/);
	});
});
