import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { loadBuiltins, registry } from "./registry.js";
import { JsonlWriter } from "./jsonl.js";
import { sampleHardware } from "./hardware.js";
import type {
  AnyPlugin,
  LlmMessage,
  LlmPlugin,
  RunMode,
  RunRecord,
  SlotKind,
  SlotToPlugin,
  SttPlugin,
  TtsPlugin,
} from "./types.js";

type SlotRef = {
  name: string;
  config?: Record<string, unknown>;
};

type PromptCase = {
  id: string;
  text?: string;
  audioPath?: string;
  reference?: string;
};

type MatrixConfig = {
  mode: RunMode;
  output?: string;
  prompts: PromptCase[];
  pipelines: {
    name?: string;
    vad?: SlotRef;
    stt?: SlotRef;
    llm?: SlotRef;
    tts?: SlotRef;
  }[];
  runs?: number;
};

type RunEvent =
  | { type: "start"; pipelineIndex: number; caseId: string; pipeline: MatrixConfig["pipelines"][number] }
  | { type: "record"; record: RunRecord }
  | { type: "error"; pipelineIndex: number; caseId: string; message: string }
  | { type: "done"; totalRuns: number };

class PluginCache {
  private instances = new Map<string, AnyPlugin>();

  private key(kind: SlotKind, name: string, config: Record<string, unknown> = {}): string {
    return `${kind}:${name}:${stableStringify(config)}`;
  }

  async get<K extends SlotKind>(
    kind: K,
    name: string,
    config: Record<string, unknown> = {}
  ): Promise<SlotToPlugin<K>> {
    const key = this.key(kind, name, config);
    const cached = this.instances.get(key);
    if (cached) return cached as SlotToPlugin<K>;
    const instance = await registry.create(kind, name, config);
    this.instances.set(key, instance);
    return instance;
  }

  async teardownAll(): Promise<void> {
    for (const p of this.instances.values()) {
      await p.teardown?.().catch(() => undefined);
    }
    this.instances.clear();
  }
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(",")}}`;
}

export async function loadMatrix(path: string): Promise<MatrixConfig> {
  const raw = await readFile(path, "utf8");
  const doc = parseYaml(raw) as MatrixConfig;
  if (!doc.mode) throw new Error(`Matrix ${path} missing \`mode\``);
  if (!doc.prompts?.length) throw new Error(`Matrix ${path} has no prompts`);
  if (!doc.pipelines?.length) throw new Error(`Matrix ${path} has no pipelines`);
  return doc;
}

export async function* runMatrix(
  matrix: MatrixConfig,
  opts: { runsPath?: string } = {}
): AsyncGenerator<RunEvent> {
  await loadBuiltins();
  const writer = opts.runsPath ? new JsonlWriter(opts.runsPath) : null;
  const cache = new PluginCache();
  const repeats = matrix.runs ?? 1;
  let total = 0;

  try {
    for (let pIdx = 0; pIdx < matrix.pipelines.length; pIdx++) {
      const pipeline = matrix.pipelines[pIdx]!;
      for (const prompt of matrix.prompts) {
        for (let r = 0; r < repeats; r++) {
          yield { type: "start", pipelineIndex: pIdx, caseId: prompt.id, pipeline };
          try {
            const record = await runOnce(matrix.mode, pipeline, prompt, cache);
            writer?.append(record);
            yield { type: "record", record };
            total++;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            yield { type: "error", pipelineIndex: pIdx, caseId: prompt.id, message };
          }
        }
      }
    }
  } finally {
    await cache.teardownAll();
    await writer?.close();
  }
  yield { type: "done", totalRuns: total };
}

async function runOnce(
  mode: RunMode,
  pipeline: MatrixConfig["pipelines"][number],
  prompt: PromptCase,
  cache: PluginCache
): Promise<RunRecord> {
  const runId = randomUUID();
  const ts = new Date().toISOString();
  const timings: Record<string, number> = {};
  const metrics: RunRecord["metrics"] = {};
  const started = performance.now();
  let output: RunRecord["output"] = {};
  let error: string | null = null;

  try {
    let userText = prompt.text ?? "";

    if (mode !== "text-to-text") {
      if (!pipeline.stt) throw new Error("Mode requires STT plugin");
      if (!prompt.audioPath) throw new Error(`Prompt ${prompt.id} missing audioPath`);
      const sttPlugin: SttPlugin = await cache.get(
        "stt",
        pipeline.stt.name,
        pipeline.stt.config
      );
      const audio = await readFile(prompt.audioPath);
      const stt = await sttPlugin.transcribe(audio, inferFormat(prompt.audioPath));
      output.sttText = stt.text;
      userText = stt.text;
      Object.assign(timings, prefix("stt.", stt.timings));
    }

    if (pipeline.llm) {
      const llmPlugin: LlmPlugin = await cache.get(
        "llm",
        pipeline.llm.name,
        pipeline.llm.config
      );
      const messages: LlmMessage[] = [{ role: "user", content: userText }];
      let text = "";
      let lastTimings: Record<string, number> | undefined;
      let lastMetadata: Record<string, unknown> | undefined;
      for await (const chunk of llmPlugin.generate(messages)) {
        text += chunk.text;
        lastTimings = chunk.timings;
        lastMetadata = chunk.metadata;
      }
      output.text = text;
      if (lastTimings) {
        Object.assign(timings, prefix("llm.", lastTimings));
        if (lastTimings.ttftMs) metrics.ttftMs = lastTimings.ttftMs;
        if (lastTimings.loadMs) metrics.loadMs = lastTimings.loadMs;
      }
      if (lastMetadata) {
        metrics.promptTokens = lastMetadata.promptTokens as number;
        metrics.completionTokens = lastMetadata.completionTokens as number;
        const evalMs = lastMetadata.evalDurationMs as number | undefined;
        if (metrics.completionTokens && evalMs && evalMs > 0) {
          metrics.tps = metrics.completionTokens / (evalMs / 1000);
        }
      }
    }

    if (mode === "voice-to-voice" && pipeline.tts && output.text) {
      const ttsPlugin: TtsPlugin = await cache.get(
        "tts",
        pipeline.tts.name,
        pipeline.tts.config
      );
      const tts = await ttsPlugin.synthesize(output.text);
      output.audioBytes = tts.audio.length;
      Object.assign(timings, prefix("tts.", tts.timings));
      if (tts.timings.firstAudioMs) metrics.firstAudioMs = tts.timings.firstAudioMs;
    }

    metrics.totalMs = performance.now() - started;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const hw = await sampleHardware("ollama");

  return {
    ts,
    runId,
    mode,
    hardware: {
      machine: hw.machine,
      platform: hw.platform,
      memoryResidentGb: hw.processResidentGb,
      memoryPressure: hw.memoryPressure,
    },
    pipeline: {
      ...(pipeline.vad && { vad: pipeline.vad }),
      ...(pipeline.stt && { stt: pipeline.stt }),
      ...(pipeline.llm && { llm: pipeline.llm }),
      ...(pipeline.tts && { tts: pipeline.tts }),
    },
    input: {
      kind: mode === "text-to-text" ? "text" : "audio",
      summary: (prompt.text ?? prompt.audioPath ?? prompt.id).slice(0, 120),
    },
    output,
    timings,
    metrics,
    error,
  };
}

function inferFormat(path: string): "wav" | "mp3" | "pcm16" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.endsWith(".pcm") || lower.endsWith(".raw")) return "pcm16";
  return "wav";
}

function prefix(p: string, obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) out[p + k] = v;
  return out;
}
