import FormData from "form-data";
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
    const form = new FormData();
    form.append("file", audio, {
      filename: `audio.${format}`,
      contentType: `audio/${format === "pcm16" ? "wav" : format}`,
    });
    form.append("response_format", "json");
    form.append("language", this.language);

    const res = await fetch(`${this.serverUrl}/inference`, {
      method: "POST",
      body: form as unknown as BodyInit,
      headers: form.getHeaders(),
    });
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
