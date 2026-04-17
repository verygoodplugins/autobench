export type RunRecord = {
  ts: string;
  runId: string;
  mode: "voice-to-voice" | "voice-to-text" | "text-to-text";
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
  output?: { text?: string; audioBytes?: number; sttText?: string };
  timings: Record<string, number>;
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

export type RunFile = {
  file: string;
  records: number;
  summary: string;
};

export type RunFileDetail = {
  file: string;
  records: RunRecord[];
};
