import { NonRealTimeVAD } from "@ricky0123/vad-node";
import { registry } from "../../core/registry.js";
import type { VadPlugin } from "../../core/types.js";

type SileroConfig = {
  threshold?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  prefixMs?: number;
};

const FRAME_SAMPLES = 1536;
const TARGET_SR = 16000;
const MS_PER_FRAME = (FRAME_SAMPLES / TARGET_SR) * 1000;

class SileroPlugin implements VadPlugin<SileroConfig> {
  readonly kind = "vad" as const;
  readonly name = "silero";
  readonly description =
    "Silero VAD via @ricky0123/vad-node (ONNX). Frame-accurate speech segments.";

  private threshold = 0.5;
  private silenceMs = 700;
  private prefixMs = 300;
  private minSpeechMs = 250;
  private vad: NonRealTimeVAD | null = null;

  async init(config: SileroConfig = {}): Promise<void> {
    if (config.threshold !== undefined) this.threshold = config.threshold;
    if (config.silenceMs !== undefined) this.silenceMs = config.silenceMs;
    if (config.prefixMs !== undefined) this.prefixMs = config.prefixMs;
    if (config.minSpeechMs !== undefined) this.minSpeechMs = config.minSpeechMs;
  }

  private async ensureModel(): Promise<NonRealTimeVAD> {
    if (this.vad) return this.vad;
    const positive = clamp01(this.threshold);
    this.vad = await NonRealTimeVAD.new({
      positiveSpeechThreshold: positive,
      negativeSpeechThreshold: clamp01(positive - 0.15),
      redemptionFrames: Math.max(1, Math.round(this.silenceMs / MS_PER_FRAME)),
      frameSamples: FRAME_SAMPLES,
      preSpeechPadFrames: Math.max(0, Math.round(this.prefixMs / MS_PER_FRAME)),
      minSpeechFrames: Math.max(1, Math.round(this.minSpeechMs / MS_PER_FRAME)),
      submitUserSpeechOnPause: false,
    });
    return this.vad;
  }

  async detect(
    audio: Buffer,
    sampleRateHz: number
  ): Promise<{
    events: { startedMs: number; endedMs: number; confidence?: number }[];
    timings: Record<string, number>;
  }> {
    const loadStarted = performance.now();
    const vad = await this.ensureModel();
    const loadMs = performance.now() - loadStarted;

    const detectStarted = performance.now();
    const float32 = pcm16ToFloat32(audio);
    const events: { startedMs: number; endedMs: number }[] = [];
    for await (const seg of vad.run(float32, sampleRateHz)) {
      events.push({ startedMs: seg.start, endedMs: seg.end });
    }
    const detectMs = performance.now() - detectStarted;

    return {
      events,
      timings: { detectMs, loadMs },
    };
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function pcm16ToFloat32(buf: Buffer): Float32Array {
  const int16 = new Int16Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.byteLength / 2)
  );
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i]! / 32768;
  return out;
}

registry.register("vad", "silero", async () => new SileroPlugin());
