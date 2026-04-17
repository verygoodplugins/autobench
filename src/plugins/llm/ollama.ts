import { registry } from "../../core/registry.js";
import type { LlmMessage, LlmPlugin, Timings } from "../../core/types.js";

type OllamaConfig = {
  baseUrl?: string;
  model: string;
  numCtx?: number;
  numPredict?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  think?: boolean;
};

class OllamaPlugin implements LlmPlugin<OllamaConfig> {
  readonly kind = "llm" as const;
  readonly name = "ollama";
  readonly description = "Ollama chat completions via /api/chat (streaming).";

  private baseUrl = "http://localhost:11434";
  private model = "llama3.3:70b";
  private numCtx = 8192;
  private numPredict = 512;
  private temperature = 0.7;
  private topP = 0.9;
  private topK = 40;
  private think = false;

  async init(config: OllamaConfig): Promise<void> {
    if (!config.model) throw new Error("ollama plugin requires `model`");
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    this.model = config.model;
    if (config.numCtx !== undefined) this.numCtx = config.numCtx;
    if (config.numPredict !== undefined) this.numPredict = config.numPredict;
    if (config.temperature !== undefined) this.temperature = config.temperature;
    if (config.topP !== undefined) this.topP = config.topP;
    if (config.topK !== undefined) this.topK = config.topK;
    if (config.think !== undefined) this.think = config.think;
  }

  async healthCheck() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return { healthy: false, reason: `HTTP ${res.status}` };
      const data = (await res.json()) as { models?: { name: string }[] };
      const modelAvailable = !!data.models?.some((m) =>
        m.name.includes(this.model.split(":")[0]!)
      );
      return {
        healthy: true,
        details: { model: this.model, modelAvailable, url: this.baseUrl },
      };
    } catch (e) {
      return {
        healthy: false,
        reason: `Cannot reach Ollama at ${this.baseUrl}`,
      };
    }
  }

  async *generate(
    messages: LlmMessage[],
    opts: { maxTokens?: number; temperature?: number; stream?: boolean } = {}
  ): AsyncIterable<{
    text: string;
    done: boolean;
    timings?: Timings;
    metadata?: Record<string, unknown>;
  }> {
    const started = performance.now();
    let firstTokenAt: number | null = null;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: opts.stream !== false,
        think: this.think,
        options: {
          temperature: opts.temperature ?? this.temperature,
          top_p: this.topP,
          top_k: this.topK,
          num_predict: opts.maxTokens ?? this.numPredict,
          num_ctx: this.numCtx,
        },
      }),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    if (!res.body) throw new Error("Ollama returned empty body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const json = JSON.parse(line) as {
          message?: { content?: string };
          done: boolean;
          total_duration?: number;
          load_duration?: number;
          prompt_eval_count?: number;
          prompt_eval_duration?: number;
          eval_count?: number;
          eval_duration?: number;
        };
        const text = json.message?.content ?? "";
        if (text && firstTokenAt === null) firstTokenAt = performance.now();
        yield {
          text,
          done: json.done,
          timings: {
            ttftMs: firstTokenAt ? firstTokenAt - started : 0,
            totalMs: performance.now() - started,
            loadMs: json.load_duration ? json.load_duration / 1e6 : 0,
          },
          metadata: {
            promptTokens: json.prompt_eval_count,
            completionTokens: json.eval_count,
            evalDurationMs: json.eval_duration
              ? json.eval_duration / 1e6
              : undefined,
          },
        };
      }
    }
  }
}

registry.register("llm", "ollama", async () => new OllamaPlugin());
