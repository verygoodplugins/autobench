import { registry } from "../../core/registry.js";
import type { SttPlugin } from "../../core/types.js";

type WhisperServerConfig = {
  serverUrl?: string;
  language?: string;
};

class WhisperServerPlugin implements SttPlugin<WhisperServerConfig> {
  readonly kind = "stt" as const;
  readonly name = "whisper-server";
  readonly description =
    "whisper.cpp server (OpenAI-compatible /inference). Model stays warm.";

  private serverUrl = "http://localhost:8178";
  private language = "en";

  async init(config: WhisperServerConfig = {}): Promise<void> {
    if (config.serverUrl) this.serverUrl = config.serverUrl;
    if (config.language) this.language = config.language;
  }

  async healthCheck() {
    try {
      const res = await fetch(`${this.serverUrl}/health`);
      return { healthy: res.ok, details: { url: this.serverUrl } };
    } catch (e) {
      return {
        healthy: false,
        reason: `whisper-server not running at ${this.serverUrl}`,
      };
    }
  }

  async transcribe(
    audio: Buffer,
    format: "wav" | "pcm16" | "mp3"
  ): Promise<{
    text: string;
    timings: Record<string, number>;
    metadata?: Record<string, unknown>;
  }> {
    const started = performance.now();
    const mime = format === "pcm16" ? "audio/wav" : `audio/${format}`;
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mime }),
      `audio.${format}`
    );
    form.append("response_format", "json");
    form.append("language", this.language);

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/inference`, {
        method: "POST",
        body: form,
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause;
      if (cause?.code === "ECONNREFUSED") {
        throw new Error(
          `whisper-server not reachable at ${this.serverUrl}. Start it (default :8178) or set WHISPER_SERVER_URL in the autobench server env.`
        );
      }
      throw new Error(
        `whisper-server fetch failed at ${this.serverUrl}: ${(e as Error).message}`
      );
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`whisper-server ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { text?: string };
    return {
      text: (data.text || "").trim(),
      timings: { transcribeMs: performance.now() - started },
      metadata: { provider: "whisper-server", url: this.serverUrl },
    };
  }
}

registry.register("stt", "whisper-server", async () => new WhisperServerPlugin());
