/**
 * Small PCM/base64 helpers shared by the audio models. The neutral
 * `AgentModel` contract fixes the audio shapes at its edges — mic input is
 * 16-bit PCM @ 16 kHz base64 (`sendAudioChunk`), speaker output is 16-bit PCM
 * @ 24 kHz base64 (`audio-out`) — so any provider that speaks a different
 * rate or container adapts here, inside its own adapter, and the `Agent` never
 * knows. Browser-safe (uses `atob`/`btoa`, no Node Buffers).
 */

/** Decode base64 into raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Encode raw bytes as base64 (chunked so large buffers don't blow the arg limit). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** View base64-encoded 16-bit little-endian PCM as samples (drops a trailing odd byte). */
export function base64ToInt16(base64: string): Int16Array {
	const bytes = base64ToBytes(base64);
	return new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
}

/** Encode 16-bit PCM samples as base64. */
export function int16ToBase64(samples: Int16Array): string {
	return bytesToBase64(
		new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
	);
}

/**
 * Linear-interpolation resampler for 16-bit PCM. Good enough for speech
 * (providers re-encode anyway); operates per-chunk, so a chunk boundary loses
 * at most one sample of continuity.
 */
export function resamplePcm16(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
	if (fromRate === toRate || samples.length === 0) return samples;
	const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
	const out = new Int16Array(outLength);
	const step = (samples.length - 1) / Math.max(1, outLength - 1);
	for (let i = 0; i < outLength; i++) {
		const pos = i * step;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, samples.length - 1);
		const frac = pos - i0;
		out[i] = (samples[i0] * (1 - frac) + samples[i1] * frac) | 0;
	}
	return out;
}

/** Average interleaved multi-channel PCM down to mono. */
export function downmixToMono(samples: Int16Array, channels: number): Int16Array {
	if (channels <= 1) return samples;
	const frames = Math.floor(samples.length / channels);
	const mono = new Int16Array(frames);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += samples[f * channels + c];
		mono[f] = (sum / channels) | 0;
	}
	return mono;
}

export interface WavPcm {
	/** Interleaved 16-bit samples from the `data` chunk. */
	samples: Int16Array;
	sampleRate: number;
	channels: number;
}

/**
 * Parse a (16-bit PCM) WAV container into raw samples + format. Walks the
 * RIFF chunk list rather than assuming a 44-byte header, so extra chunks
 * (`LIST`, `fact`…) don't break it. Throws on non-PCM or non-16-bit audio.
 */
export function wavToPcm16(bytes: Uint8Array): WavPcm {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset: number) =>
		String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
	if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
		throw new Error('Not a RIFF/WAVE container');
	}
	let channels = 1;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let dataOffset = -1;
	let dataLength = 0;
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === 'fmt ') {
			const format = view.getUint16(body, true);
			if (format !== 1) throw new Error(`Unsupported WAV format ${format} (PCM only)`);
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bitsPerSample = view.getUint16(body + 14, true);
		} else if (id === 'data') {
			dataOffset = body;
			dataLength = Math.min(size, bytes.byteLength - body);
		}
		// Chunks are word-aligned: odd sizes carry a pad byte.
		offset = body + size + (size % 2);
	}
	if (sampleRate === 0 || dataOffset < 0) throw new Error('WAV missing fmt/data chunk');
	if (bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth ${bitsPerSample}`);
	const samples = new Int16Array(Math.floor(dataLength / 2));
	for (let i = 0; i < samples.length; i++) {
		samples[i] = view.getInt16(dataOffset + i * 2, true);
	}
	return { samples, sampleRate, channels };
}
