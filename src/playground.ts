import express, { type Express, type Response } from "express";
import { PluginCache } from "./core/plugin-cache.js";
import type { LlmMessage, SlotKind } from "./core/types.js";

type SlotRef = { name: string; config?: Record<string, unknown> };

type ChatBody = {
  llm: SlotRef;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
};

type VoiceBody = {
  stt: SlotRef;
  llm: SlotRef;
  tts?: SlotRef;
  audio: string;
  audioFormat?: "wav" | "pcm16" | "mp3";
  system?: string;
};

const CONFIG_ALLOWLIST: Record<string, Record<string, readonly string[]>> = {
  llm: {
    ollama: ["model", "numCtx", "numPredict", "temperature", "topP", "topK", "think"],
    claude: ["model", "maxTokens", "temperature", "thinking"],
  },
  stt: {
    "whisper-server": ["language"],
    parakeet: ["language"],
  },
  tts: {
    kokoro: ["voice", "dtype", "device"],
    "macos-say": ["voice"],
    piper: ["speaker", "lengthScale"],
  },
  vad: {
    silero: ["threshold", "minSpeechMs", "silenceMs", "prefixMs"],
    "sox-silence": ["threshold", "minSilenceSeconds"],
  },
};

function sanitizeConfig(
  slot: SlotKind,
  name: string,
  raw: Record<string, unknown> = {}
): Record<string, unknown> {
  const allowed = CONFIG_ALLOWLIST[slot]?.[name];
  if (!allowed) {
    throw new Error(`plugin not permitted in playground: ${slot}/${name}`);
  }
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }

  if (slot === "stt" && name === "whisper-server") {
    out.serverUrl = process.env.WHISPER_SERVER_URL ?? "http://localhost:8178";
  }
  if (slot === "stt" && name === "parakeet") {
    out.serverUrl = process.env.PARAKEET_SERVER_URL ?? "http://localhost:8179";
  }
  if (slot === "llm" && name === "ollama") {
    out.baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  }
  if (slot === "tts" && name === "piper") {
    if (!process.env.PIPER_MODEL) {
      throw new Error("piper requires PIPER_MODEL env var in the server process");
    }
    out.model = process.env.PIPER_MODEL;
    if (process.env.PIPER_BINARY) out.binary = process.env.PIPER_BINARY;
    if (process.env.PIPER_MODEL_CONFIG) out.modelConfig = process.env.PIPER_MODEL_CONFIG;
  }
  return out;
}

function sseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function sseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Sentence-buffer flush heuristic for streaming TTS. Mirrors the sibling
// uncensored-voice-server's shouldFlushSegment: aggressive on the first
// segment to minimize first-audio latency, smoother cadence afterwards.
const FIRST_SEGMENT_MIN_CHARS = 32;
const CONT_SEGMENT_MIN_CHARS = 60;
const MAX_SEGMENT_CHARS = 240;
const HARD_PUNCT_RE = /[.!?\n]/;

function tryFlushSegment(
  buf: string,
  isFirst: boolean
): { flush: string; rest: string } | null {
  const minChars = isFirst ? FIRST_SEGMENT_MIN_CHARS : CONT_SEGMENT_MIN_CHARS;

  const hardIdx = buf.search(HARD_PUNCT_RE);
  if (hardIdx >= 0 && hardIdx + 1 >= minChars) {
    const cut = hardIdx + 1;
    return {
      flush: buf.slice(0, cut).trim(),
      rest: buf.slice(cut).trimStart(),
    };
  }

  if (buf.length >= MAX_SEGMENT_CHARS) {
    const spaceIdx = buf.lastIndexOf(" ", MAX_SEGMENT_CHARS);
    const cut = spaceIdx >= minChars ? spaceIdx : MAX_SEGMENT_CHARS;
    return {
      flush: buf.slice(0, cut).trim(),
      rest: buf.slice(cut).trimStart(),
    };
  }

  return null;
}

// Preference order for the default TTS. First entry wins when available.
// Kokoro can be opted out with AUTOBENCH_DISABLE_KOKORO=1 — useful while the
// kokoro-js + onnxruntime-node stack is shaking out (see open follow-up #1).
const TTS_PREFERENCE = ["kokoro", "piper", "macos-say"] as const;

function ttsAvailability(): Record<string, { available: boolean; reason?: string }> {
  return {
    kokoro: process.env.AUTOBENCH_DISABLE_KOKORO
      ? { available: false, reason: "disabled via AUTOBENCH_DISABLE_KOKORO" }
      : { available: true },
    piper: process.env.PIPER_MODEL
      ? { available: true }
      : { available: false, reason: "PIPER_MODEL env var not set on server" },
    "macos-say": process.platform === "darwin"
      ? { available: true }
      : { available: false, reason: "macos-say only runs on darwin" },
  };
}

function pickDefaultTts(): { name: string; preference: readonly string[]; availability: Record<string, { available: boolean; reason?: string }> } {
  const availability = ttsAvailability();
  const name = TTS_PREFERENCE.find((n) => availability[n]?.available) ?? "macos-say";
  return { name, preference: TTS_PREFERENCE, availability };
}

export function registerPlaygroundRoutes(app: Express): void {
  const cache = new PluginCache();
  const router = express.Router();
  router.use(express.json({ limit: "25mb" }));

  router.get("/defaults", (_req, res) => {
    res.json({ tts: pickDefaultTts() });
  });

  router.post("/chat/stream", async (req, res) => {
    const body = req.body as ChatBody | undefined;
    if (!body?.llm?.name || !Array.isArray(body.messages) || !body.messages.length) {
      res.status(400).json({ error: "expected { llm: { name }, messages: [...] }" });
      return;
    }

    let cfg: Record<string, unknown>;
    try {
      cfg = sanitizeConfig("llm", body.llm.name, body.llm.config);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }

    sseHeaders(res);

    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    try {
      const plugin = await cache.get("llm", body.llm.name, cfg);
      sseEvent(res, "ready", { plugin: body.llm.name });

      const gen = plugin.generate(body.messages, {
        maxTokens: body.maxTokens,
        temperature: body.temperature,
      });
      for await (const chunk of gen) {
        if (closed) break;
        if (chunk.text) {
          sseEvent(res, "token", { text: chunk.text, timings: chunk.timings });
        }
        if (chunk.done) {
          sseEvent(res, "done", {
            timings: chunk.timings,
            metadata: chunk.metadata,
          });
        }
      }
    } catch (e) {
      sseEvent(res, "error", { message: (e as Error).message });
    } finally {
      res.end();
    }
  });

  router.post("/voice/turn", async (req, res) => {
    const body = req.body as VoiceBody | undefined;
    if (!body?.stt?.name || !body?.llm?.name || !body?.audio) {
      res.status(400).json({ error: "expected { stt, llm, audio, tts? }" });
      return;
    }

    let sttCfg: Record<string, unknown>;
    let llmCfg: Record<string, unknown>;
    let ttsCfg: Record<string, unknown> | undefined;
    const format = body.audioFormat ?? "wav";
    try {
      if (!["wav", "pcm16", "mp3"].includes(format)) {
        throw new Error(`unsupported audioFormat: ${format}`);
      }
      sttCfg = sanitizeConfig("stt", body.stt.name, body.stt.config);
      llmCfg = sanitizeConfig("llm", body.llm.name, body.llm.config);
      if (body.tts) ttsCfg = sanitizeConfig("tts", body.tts.name, body.tts.config);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }

    sseHeaders(res);
    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    try {
      const audioBuf = Buffer.from(body.audio, "base64");

      const stt = await cache.get("stt", body.stt.name, sttCfg);
      sseEvent(res, "stt-start", { plugin: body.stt.name });
      const sttStart = performance.now();
      const sttResult = await stt.transcribe(audioBuf, format);
      const sttMs = performance.now() - sttStart;
      sseEvent(res, "transcript", { text: sttResult.text, ms: sttMs });

      if (closed) return;
      if (!sttResult.text.trim()) {
        sseEvent(res, "done", { sttMs, reason: "empty-transcript" });
        return;
      }

      const llm = await cache.get("llm", body.llm.name, llmCfg);
      const messages: LlmMessage[] = [];
      if (body.system) messages.push({ role: "system", content: body.system });
      messages.push({ role: "user", content: sttResult.text });

      // Streaming TTS pipeline: LLM tokens feed a sentence buffer, full
      // sentences go to a TTS worker that synthesizes concurrently with
      // further token generation. Each synthesized segment is emitted as
      // its own `audio` SSE event so the client can start playback well
      // before the full response arrives.
      const doTts = Boolean(body.tts && ttsCfg);
      const tts = doTts ? await cache.get("tts", body.tts!.name, ttsCfg!) : null;

      type SegmentJob = { text: string; index: number };
      const ttsQueue: SegmentJob[] = [];
      let segmentIndex = 0;
      let drainerPromise: Promise<void> | null = null;

      function startDrainerIfIdle(): void {
        if (drainerPromise || !tts) return;
        drainerPromise = (async () => {
          while (ttsQueue.length > 0 && !closed) {
            const job = ttsQueue.shift()!;
            try {
              const t0 = performance.now();
              const result = await tts.synthesize(job.text);
              const ms = performance.now() - t0;
              if (closed) return;
              sseEvent(res, "audio", {
                base64: result.audio.toString("base64"),
                format: result.format,
                ms,
                timings: result.timings,
                index: job.index,
                text: job.text,
              });
            } catch (e) {
              if (!closed) {
                sseEvent(res, "tts-error", {
                  message: (e as Error).message,
                  text: job.text,
                });
              }
            }
          }
          drainerPromise = null;
        })();
      }

      function enqueueSegment(text: string): void {
        const trimmed = text.trim();
        if (!trimmed || !tts) return;
        ttsQueue.push({ text: trimmed, index: segmentIndex++ });
        startDrainerIfIdle();
      }

      let fullText = "";
      let buffer = "";
      let llmTimings: Record<string, number> | undefined;
      let llmMeta: Record<string, unknown> | undefined;
      for await (const chunk of llm.generate(messages)) {
        if (closed) break;
        if (chunk.text) {
          fullText += chunk.text;
          buffer += chunk.text;
          sseEvent(res, "token", { text: chunk.text, timings: chunk.timings });
          if (tts) {
            while (true) {
              const result = tryFlushSegment(buffer, segmentIndex === 0);
              if (!result) break;
              buffer = result.rest;
              enqueueSegment(result.flush);
            }
          }
        }
        if (chunk.done) {
          llmTimings = chunk.timings;
          llmMeta = chunk.metadata;
        }
      }
      if (closed) return;
      sseEvent(res, "llm-done", {
        text: fullText,
        timings: llmTimings,
        metadata: llmMeta,
      });

      if (tts) {
        if (buffer.trim()) enqueueSegment(buffer);
        if (drainerPromise) await drainerPromise;
      }
      if (closed) return;
      sseEvent(res, "done", { sttMs, segments: segmentIndex });
    } catch (e) {
      sseEvent(res, "error", { message: (e as Error).message });
    } finally {
      res.end();
    }
  });

  app.use("/playground", router);
}
