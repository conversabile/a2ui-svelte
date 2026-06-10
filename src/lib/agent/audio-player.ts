export class AudioPlayer {
    private audioContext: AudioContext;
    private sampleRate: number;
    private nextStartTime: number = 0;
    private scheduledSources: AudioBufferSourceNode[] = [];

    // Safety margin (in seconds) to prevent stuttering due to main thread jitter
    private readonly driftThreshold = 0.2;
    private readonly initialBufferDelay = 0.15; // 150ms initial cushion

    private isBuffering = true;
    private chunkBuffer: Float32Array[] = [];
    private bufferThreshold = 4; // Number of chunks to hold before starting

    constructor(sampleRate: number = 24000) {
        this.sampleRate = sampleRate;
        // Don't force sampleRate on the AudioContext — let the browser use its
        // native hardware rate.  createBuffer() already tags each buffer with
        // this.sampleRate so the browser resamples transparently.  Forcing a
        // non-native rate adds overhead and can cause stuttering (esp. Firefox).
        this.audioContext = new AudioContext();
        // Resume eagerly while we're still inside the user-gesture callstack
        // (click on the mic button).  Mobile browsers suspend new contexts by
        // default; resuming later outside a gesture may be silently ignored.
        this.audioContext.resume();
    }

    addToQueue(base64Data: string) {
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        // 1. Robust Base64 to Float32 conversion
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Ensure we don't have a partial frame (Int16 = 2 bytes)
        const numSamples = Math.floor(bytes.byteLength / 2);
        const int16Data = new Int16Array(bytes.buffer, 0, numSamples);
        const float32Data = new Float32Array(numSamples);

        for (let i = 0; i < numSamples; i++) {
            float32Data[i] = int16Data[i] / 32768.0;
        }

        // 2. Jitter Buffer Logic
        if (this.isBuffering) {
            this.chunkBuffer.push(float32Data);
            if (this.chunkBuffer.length >= this.bufferThreshold) {
                this.isBuffering = false;
                this.flushInitialBuffer();
            }
        } else {
            this.scheduleBuffer(float32Data);
        }
    }

    private flushInitialBuffer() {
        // Start the very first chunk with a healthy cushion
        this.nextStartTime = this.audioContext.currentTime + this.initialBufferDelay;
        while (this.chunkBuffer.length > 0) {
            const chunk = this.chunkBuffer.shift();
            if (chunk) this.scheduleBuffer(chunk);
        }
    }

    private scheduleBuffer(audioData: Float32Array) {
        const audioBuffer = this.audioContext.createBuffer(1, audioData.length, this.sampleRate);
        audioBuffer.getChannelData(0).set(audioData);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        // 3. Precise Scheduling
        // If we are late, we don't jump far ahead; we snap to 'now' + a tiny margin
        const currentTime = this.audioContext.currentTime;
        if (this.nextStartTime < currentTime) {
            this.nextStartTime = currentTime + 0.01;
        }

        source.start(this.nextStartTime);
        this.scheduledSources.push(source);

        // Increment next start time by the exact duration of the buffer
        this.nextStartTime += audioBuffer.duration;

        source.onended = () => {
            const index = this.scheduledSources.indexOf(source);
            if (index > -1) this.scheduledSources.splice(index, 1);

            // Auto-rebuffer if we run completely out of scheduled audio
            if (this.scheduledSources.length === 0 && !this.isBuffering) {
                this.isBuffering = true;
            }
        };
    }

    stop() {
        this.scheduledSources.forEach(s => { try { s.stop(); } catch (e) { } });
        this.scheduledSources = [];
        this.chunkBuffer = [];
        this.isBuffering = true;
        this.nextStartTime = 0;
    }
}