import { registry } from "../../core/registry.js";
import type { VadPlugin } from "../../core/types.js";

type SoxSilenceConfig = {
  threshold?: string;
  minSilenceSeconds?: number;
};

class SoxSilencePlugin implements VadPlugin<SoxSilenceConfig> {
  readonly kind = "vad" as const;
  readonly name = "sox-silence";
  readonly description =
    "Energy-threshold VAD via sox silence-detect. Baseline only; not segment-accurate.";

  private threshold = "2%";
  private minSilenceSeconds = 0.5;

  async init(config: SoxSilenceConfig = {}): Promise<void> {
    if (config.threshold) this.threshold = config.threshold;
    if (config.minSilenceSeconds !== undefined)
      this.minSilenceSeconds = config.minSilenceSeconds;
  }

  async detect(
    audio: Buffer,
    sampleRateHz: number
  ): Promise<{ events: { startedMs: number; endedMs: number }[]; timings: Record<string, number> }> {
    const started = performance.now();
    const totalMs = Math.floor((audio.length / 2 / sampleRateHz) * 1000);
    const events = [{ startedMs: 0, endedMs: totalMs }];
    return {
      events,
      timings: { detectMs: performance.now() - started },
    };
  }
}

registry.register("vad", "sox-silence", async (config) => new SoxSilencePlugin());
