import { Capacitor } from '@capacitor/core';

export class AudioRecorder extends EventTarget {
    private audioContext: AudioContext | null = null;
    private mediaStream: MediaStream | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private scriptProcessor: ScriptProcessorNode | null = null;
    private input: MediaStreamAudioSourceNode | null = null;
    private targetSampleRate = 16000;

    async start() {
        try {
            await this.requestPermission();

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: this.targetSampleRate,
                },
            });

            this.audioContext = new AudioContext();
            // Ensure context is running (mobile browsers may start suspended)
            await this.audioContext.resume();

            this.input = this.audioContext.createMediaStreamSource(this.mediaStream);

            // AudioWorklet runs off the main thread — fixes Firefox stuttering.
            // Falls back to deprecated ScriptProcessorNode on older browsers.
            try {
                await this.setupAudioWorklet();
            } catch (e) {
                console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', e);
                this.setupScriptProcessor();
            }
        } catch (error) {
            console.error('Error starting audio recorder:', error);
            throw error;
        }
    }

    private async requestPermission() {
        if (Capacitor.isNativePlatform()) {
            // Native Capacitor shell — use plugin for runtime permissions
            const { VoiceRecorder } = await import('capacitor-voice-recorder');
            const canRecord = await VoiceRecorder.canDeviceVoiceRecord();
            if (!canRecord.value) {
                throw new Error('Device cannot record voice');
            }
            const permission = await VoiceRecorder.requestAudioRecordingPermission();
            if (!permission.value) {
                throw new Error('Audio recording permission denied');
            }
        } else {
            // Web browser — getUserMedia requires a secure context (HTTPS or localhost)
            if (!isSecureContext) {
                throw new Error(
                    'Microphone access requires a secure context (HTTPS or localhost). ' +
                    'For mobile testing, run: npm run dev:mobile'
                );
            }
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('getUserMedia is not supported in this browser');
            }
        }
    }

    private async setupAudioWorklet() {
        const processorCode = `
class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._bufferSize = 4096;
        this._buffer = new Float32Array(this._bufferSize);
        this._writeIndex = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const channelData = input[0];
        if (!channelData) return true;

        for (let i = 0; i < channelData.length; i++) {
            this._buffer[this._writeIndex++] = channelData[i];
            if (this._writeIndex >= this._bufferSize) {
                this.port.postMessage({ audioData: this._buffer }, [this._buffer.buffer]);
                this._buffer = new Float32Array(this._bufferSize);
                this._writeIndex = 0;
            }
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);
`;
        const blob = new Blob([processorCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        try {
            await this.audioContext!.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }

        this.workletNode = new AudioWorkletNode(this.audioContext!, 'pcm-processor');
        this.workletNode.port.onmessage = (e: MessageEvent) => {
            this.processAndEmit(e.data.audioData as Float32Array);
        };

        this.input!.connect(this.workletNode);
        // Must connect to destination to keep the audio graph alive
        this.workletNode.connect(this.audioContext!.destination);
    }

    private setupScriptProcessor() {
        this.scriptProcessor = this.audioContext!.createScriptProcessor(4096, 1, 1);
        this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
            this.processAndEmit(e.inputBuffer.getChannelData(0));
        };
        this.input!.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioContext!.destination);
    }

    private processAndEmit(inputData: Float32Array) {
        const inputSampleRate = this.audioContext!.sampleRate;

        let processedData = inputData;
        if (inputSampleRate !== this.targetSampleRate) {
            processedData = this.downsampleBuffer(inputData, inputSampleRate, this.targetSampleRate);
        }

        const pcmData = new Int16Array(processedData.length);
        for (let i = 0; i < processedData.length; i++) {
            const s = Math.max(-1, Math.min(1, processedData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const bytes = new Uint8Array(pcmData.buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        this.dispatchEvent(new CustomEvent('data', { detail: btoa(binary) }));
    }

    private downsampleBuffer(buffer: Float32Array, inputRate: number, outputRate: number): Float32Array {
        if (outputRate >= inputRate) return buffer;
        const sampleRateRatio = inputRate / outputRate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;

        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetResult] = count > 0 ? accum / count : 0;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }

    stop() {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.scriptProcessor) {
            this.scriptProcessor.disconnect();
            this.scriptProcessor = null;
        }
        if (this.input) {
            this.input.disconnect();
            this.input = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
    }
}
