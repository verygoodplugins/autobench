import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { registry } from "../../core/registry.js";
import type { TtsPlugin } from "../../core/types.js";

const execFileAsync = promisify(execFile);

type MacSayConfig = {
  voice?: string;
};

class MacOsSayPlugin implements TtsPlugin<MacSayConfig> {
  readonly kind = "tts" as const;
  readonly name = "macos-say";
  readonly description =
    "macOS built-in `say` → ffmpeg/sox to mp3. Instant, offline, basic quality.";

  private voice = "Samantha";

  async init(config: MacSayConfig = {}): Promise<void> {
    if (config.voice) this.voice = config.voice;
    if (process.platform !== "darwin") {
      throw new Error("macos-say only works on macOS");
    }
  }

  async synthesize(text: string): Promise<{
    audio: Buffer;
    format: "mp3";
    timings: Record<string, number>;
    metadata?: Record<string, unknown>;
  }> {
    const started = performance.now();
    const ts = Date.now();
    const aiff = `/tmp/autobench-tts-${ts}.aiff`;
    const mp3 = `/tmp/autobench-tts-${ts}.mp3`;
    try {
      await execFileAsync("say", ["-v", this.voice, "-o", aiff, text]);
      try {
        await execFileAsync("ffmpeg", [
          "-i", aiff, "-acodec", "libmp3lame", "-ab", "128k", "-y", mp3,
        ]);
      } catch {
        await execFileAsync("sox", [aiff, mp3]);
      }
      const buffer = await readFile(mp3);
      return {
        audio: buffer,
        format: "mp3",
        timings: { totalMs: performance.now() - started },
        metadata: { voice: this.voice },
      };
    } finally {
      await unlink(aiff).catch(() => {});
      await unlink(mp3).catch(() => {});
    }
  }
}

registry.register("tts", "macos-say", async () => new MacOsSayPlugin());
