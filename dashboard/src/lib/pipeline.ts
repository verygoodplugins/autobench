export type LlmConfig = {
  name: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  numCtx?: number;
  topP?: number;
  topK?: number;
  think?: boolean;
  thinking?: boolean;
};

export type PipelineConfig = {
  llm: LlmConfig;
  stt: { name: string };
  tts: { name: string; enabled: boolean };
  system: string;
  voiceSystem: string;
};

export const CLAUDE_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

export const MODEL_DEFAULTS: Record<string, string> = {
  ollama: "qwen2.5-coder:32b",
  claude: "claude-haiku-4-5",
};

export const DEFAULT_VOICE_PROMPT =
  "You are in a real-time voice conversation. The user's words arrive as a raw speech-to-text transcript — expect occasional misheard homophones, missing punctuation, or chopped sentences, and infer their meaning from context rather than fixating on literal wording. If you are genuinely unsure what they meant, ask one brief clarifying question. Keep replies short and natural, like a human actually talking — typically one or two sentences unless the user asks for more. Do not emit markdown, code fences, bullet lists, or headings; your reply is spoken aloud by a text-to-speech engine. Do not spell out URLs or punctuation marks.";

export const DEFAULT_PIPELINE: PipelineConfig = {
  llm: {
    name: "ollama",
    model: MODEL_DEFAULTS.ollama!,
    temperature: 0.7,
    maxTokens: 512,
    numCtx: 8192,
    think: false,
    thinking: false,
  },
  stt: { name: "parakeet" },
  tts: { name: "macos-say", enabled: true },
  system: "",
  voiceSystem: DEFAULT_VOICE_PROMPT,
};

// Build the { name, config } payload the playground endpoints expect.
// Maps UI-level fields into plugin-specific config keys that pass the
// server-side allowlist in src/playground.ts::CONFIG_ALLOWLIST.
export function buildLlmSlot(cfg: LlmConfig): { name: string; config: Record<string, unknown> } {
  const config: Record<string, unknown> = { model: cfg.model };
  if (cfg.temperature !== undefined) config.temperature = cfg.temperature;

  if (cfg.name === "ollama") {
    if (cfg.maxTokens !== undefined) config.numPredict = cfg.maxTokens;
    if (cfg.numCtx !== undefined) config.numCtx = cfg.numCtx;
    if (cfg.topP !== undefined) config.topP = cfg.topP;
    if (cfg.topK !== undefined) config.topK = cfg.topK;
    if (cfg.think !== undefined) config.think = cfg.think;
  } else if (cfg.name === "claude") {
    if (cfg.maxTokens !== undefined) config.maxTokens = cfg.maxTokens;
    if (cfg.thinking !== undefined) config.thinking = cfg.thinking;
  }

  return { name: cfg.name, config };
}

export function numOrUndefined(s: string): number | undefined {
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
