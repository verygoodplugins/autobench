import { registry } from "../../core/registry.js";
import type { TtsPlugin } from "../../core/types.js";

type KokoroConfig = {
  voice?: string;
  dtype?: "q8" | "q4" | "fp16";
  device?: "cpu" | "webgpu";
};

class KokoroPlugin implements TtsPlugin<KokoroConfig> {
  readonly kind = "tts" as const;
  readonly name = "kokoro";
  readonly description =
    "Kokoro ONNX (~150MB) local neural TTS. Fast and offline.";

  private voice = "af_heart";
  private dtype: "q8" | "q4" | "fp16" = "q8";
  private device: "cpu" | "webgpu" = "cpu";
  private model: unknown = null;

  async init(config: KokoroConfig = {}): Promise<void> {
    if (config.voice) this.voice = config.voice;
    if (config.dtype) this.dtype = config.dtype;
    if (config.device) this.device = config.device;
  }

  async synthesize(text: string): Promise<{
    audio: Buffer;
    format: "wav";
    timings: Record<string, number>;
    metadata?: Record<string, unknown>;
  }> {
    const started = performance.now();
    let loadMs = 0;
    if (!this.model) {
      const loadStarted = performance.now();
      const { KokoroTTS } = (await import("kokoro-js")) as {
        KokoroTTS: {
          from_pretrained(
            repo: string,
            opts: { dtype: string; device: string }
          ): Promise<unknown>;
        };
      };
      this.model = await KokoroTTS.from_pretrained(
        "onnx-community/Kokoro-82M-v1.0-ONNX",
        { dtype: this.dtype, device: this.device }
      );
      loadMs = performance.now() - loadStarted;
    }
    const firstAudioStart = performance.now();
    const audio = await (
      this.model as { generate: (t: string, o: { voice: string }) => Promise<{ toWav: () => ArrayBuffer }> }
    ).generate(text, { voice: this.voice });
    const buffer = Buffer.from(audio.toWav());
    const firstAudioMs = performance.now() - firstAudioStart;
    return {
      audio: buffer,
      format: "wav",
      timings: {
        loadMs,
        firstAudioMs,
        totalMs: performance.now() - started,
      },
      metadata: { voice: this.voice, dtype: this.dtype, device: this.device },
    };
  }
}

registry.register("tts", "kokoro", async () => new KokoroPlugin());
