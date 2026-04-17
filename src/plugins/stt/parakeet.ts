import { registry } from "../../core/registry.js";
import type { SttPlugin } from "../../core/types.js";

type ParakeetConfig = {
  serverUrl?: string;
  language?: string;
};

class ParakeetPlugin implements SttPlugin<ParakeetConfig> {
  readonly kind = "stt" as const;
  readonly name = "parakeet";
  readonly description =
    "Parakeet v3 via MLX server (OpenAI-compatible /inference). Defaults to :8179 to avoid whisper-server's :8178.";

  private serverUrl = "http://localhost:8179";
  private language = "en";

  async init(config: ParakeetConfig = {}): Promise<void> {
    if (config.serverUrl) this.serverUrl = config.serverUrl;
    if (config.language) this.language = config.language;
  }

  async healthCheck() {
    try {
      const res = await fetch(`${this.serverUrl}/health`);
      if (!res.ok) return { healthy: false, reason: `HTTP ${res.status}` };
      const data = (await res.json()) as {
        status?: string;
        ready?: boolean;
        model?: string;
      };
      return {
        healthy: !!data.ready,
        details: { url: this.serverUrl, model: data.model, status: data.status },
      };
    } catch (e) {
      return {
        healthy: false,
        reason: `parakeet-server not running at ${this.serverUrl}`,
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

    const res = await fetch(`${this.serverUrl}/inference`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`parakeet-server ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { text?: string };
    return {
      text: (data.text || "").trim(),
      timings: { transcribeMs: performance.now() - started },
      metadata: { provider: "parakeet-mlx", url: this.serverUrl },
    };
  }
}

registry.register("stt", "parakeet", async () => new ParakeetPlugin());
