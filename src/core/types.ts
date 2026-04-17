export type SlotKind = "vad" | "stt" | "llm" | "tts";

export type HardwareCost = {
  ramGb?: number;
  vramGb?: number;
  requires?: string[];
};

export interface PluginBase<TConfig = Record<string, unknown>> {
  readonly kind: SlotKind;
  readonly name: string;
  readonly description?: string;
  readonly cost?: HardwareCost;
  init(config: TConfig): Promise<void>;
  teardown?(): Promise<void>;
  healthCheck?(): Promise<HealthStatus>;
}

export type HealthStatus = {
  healthy: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type Timings = Record<string, number>;

export type VadEvent = {
  startedMs: number;
  endedMs: number;
  confidence?: number;
};

export interface VadPlugin<TConfig = Record<string, unknown>>
  extends PluginBase<TConfig> {
  readonly kind: "vad";
  detect(audio: Buffer, sampleRateHz: number): Promise<{
    events: VadEvent[];
    timings: Timings;
  }>;
}

export interface SttPlugin<TConfig = Record<string, unknown>>
  extends PluginBase<TConfig> {
  readonly kind: "stt";
  transcribe(audio: Buffer, format: "wav" | "pcm16" | "mp3"): Promise<{
    text: string;
    timings: Timings;
    metadata?: Record<string, unknown>;
  }>;
}

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface LlmPlugin<TConfig = Record<string, unknown>>
  extends PluginBase<TConfig> {
  readonly kind: "llm";
  generate(
    messages: LlmMessage[],
    opts?: { maxTokens?: number; temperature?: number; stream?: boolean }
  ): AsyncIterable<{
    text: string;
    done: boolean;
    timings?: Timings;
    metadata?: Record<string, unknown>;
  }>;
}

export interface TtsPlugin<TConfig = Record<string, unknown>>
  extends PluginBase<TConfig> {
  readonly kind: "tts";
  synthesize(text: string): Promise<{
    audio: Buffer;
    format: "wav" | "mp3";
    timings: Timings;
    metadata?: Record<string, unknown>;
  }>;
}

export type AnyPlugin =
  | VadPlugin
  | SttPlugin
  | LlmPlugin
  | TtsPlugin;

export type SlotToPlugin<K extends SlotKind> = K extends "vad"
  ? VadPlugin
  : K extends "stt"
    ? SttPlugin
    : K extends "llm"
      ? LlmPlugin
      : TtsPlugin;

export type PluginFactory<P extends AnyPlugin = AnyPlugin> = (
  config: Record<string, unknown>
) => Promise<P> | P;

export type RunMode = "voice-to-voice" | "voice-to-text" | "text-to-text";

export type RunRecord = {
  ts: string;
  runId: string;
  mode: RunMode;
  hardware?: {
    machine?: string;
    platform?: string;
    memoryResidentGb?: number | null;
    memoryPressure?: string | null;
  };
  pipeline: {
    vad?: { name: string; config?: Record<string, unknown> };
    stt?: { name: string; config?: Record<string, unknown> };
    llm?: { name: string; config?: Record<string, unknown> };
    tts?: { name: string; config?: Record<string, unknown> };
  };
  input: { kind: "text" | "audio"; summary: string };
  output?: {
    text?: string;
    audioBytes?: number;
    sttText?: string;
  };
  timings: Timings;
  metrics: {
    ttftMs?: number;
    tps?: number;
    firstAudioMs?: number;
    totalMs?: number;
    rtfStt?: number;
    rtfTts?: number;
    wer?: number;
    completionTokens?: number;
    promptTokens?: number;
    loadMs?: number;
  };
  error?: string | null;
};
