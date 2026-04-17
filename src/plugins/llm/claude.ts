import Anthropic from "@anthropic-ai/sdk";
import { registry } from "../../core/registry.js";
import type { LlmMessage, LlmPlugin, Timings } from "../../core/types.js";

type ClaudeConfig = {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
};

class ClaudePlugin implements LlmPlugin<ClaudeConfig> {
  readonly kind = "llm" as const;
  readonly name = "claude";
  readonly description =
    "Anthropic Claude via Messages API (streaming). No prompt caching.";

  private client!: Anthropic;
  private model = "claude-sonnet-4-6";
  private maxTokens = 1024;
  private temperature?: number;
  private thinking = false;

  async init(config: ClaudeConfig): Promise<void> {
    if (!config.model) throw new Error("claude plugin requires `model`");
    this.model = config.model;
    if (config.maxTokens !== undefined) this.maxTokens = config.maxTokens;
    if (config.temperature !== undefined) this.temperature = config.temperature;
    if (config.thinking !== undefined) this.thinking = config.thinking;
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "claude plugin requires ANTHROPIC_API_KEY env var or apiKey in config"
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async healthCheck() {
    const haveKey = !!(this.client || process.env.ANTHROPIC_API_KEY);
    return haveKey
      ? { healthy: true, details: { model: this.model } }
      : { healthy: false, reason: "ANTHROPIC_API_KEY not set" };
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

    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    const history: { role: "user" | "assistant"; content: string }[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      messages: history,
    };
    if (systemParts.length) body.system = systemParts.join("\n\n");
    const temperature = opts.temperature ?? this.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (this.thinking) body.thinking = { type: "adaptive" };

    const stream = this.client.messages.stream(
      body as Parameters<typeof this.client.messages.stream>[0]
    );

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        yield {
          text: event.delta.text,
          done: false,
          timings: {
            ttftMs: firstTokenAt - started,
            totalMs: performance.now() - started,
          },
        };
      }
    }

    const finalMessage = await stream.finalMessage();
    const totalMs = performance.now() - started;
    const ttftMs = firstTokenAt ? firstTokenAt - started : totalMs;
    const evalDurationMs = totalMs - ttftMs;

    yield {
      text: "",
      done: true,
      timings: {
        ttftMs,
        totalMs,
      },
      metadata: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        evalDurationMs,
        stopReason: finalMessage.stop_reason,
      },
    };
  }
}

registry.register("llm", "claude", async () => new ClaudePlugin());
