import type { Express, Response } from "express";
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

export function registerPlaygroundRoutes(app: Express): void {
  const cache = new PluginCache();

  app.post("/playground/chat/stream", async (req, res) => {
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
        if (chunk.done) {
          sseEvent(res, "done", {
            timings: chunk.timings,
            metadata: chunk.metadata,
          });
        } else if (chunk.text) {
          sseEvent(res, "token", { text: chunk.text, timings: chunk.timings });
        }
      }
    } catch (e) {
      sseEvent(res, "error", { message: (e as Error).message });
    } finally {
      res.end();
    }
  });

  app.post("/playground/voice/turn", async (req, res) => {
    const body = req.body as VoiceBody | undefined;
    if (!body?.stt?.name || !body?.llm?.name || !body?.audio) {
      res.status(400).json({ error: "expected { stt, llm, audio, tts? }" });
      return;
    }

    let sttCfg: Record<string, unknown>;
    let llmCfg: Record<string, unknown>;
    let ttsCfg: Record<string, unknown> | undefined;
    try {
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
      const format = body.audioFormat ?? "wav";

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

      let fullText = "";
      let llmTimings: Record<string, number> | undefined;
      let llmMeta: Record<string, unknown> | undefined;
      for await (const chunk of llm.generate(messages)) {
        if (closed) break;
        if (chunk.done) {
          llmTimings = chunk.timings;
          llmMeta = chunk.metadata;
        } else if (chunk.text) {
          fullText += chunk.text;
          sseEvent(res, "token", { text: chunk.text, timings: chunk.timings });
        }
      }
      if (closed) return;
      sseEvent(res, "llm-done", {
        text: fullText,
        timings: llmTimings,
        metadata: llmMeta,
      });

      if (closed) return;
      if (body.tts && fullText.trim() && ttsCfg) {
        const tts = await cache.get("tts", body.tts.name, ttsCfg);
        const ttsStart = performance.now();
        const ttsResult = await tts.synthesize(fullText);
        const ttsMs = performance.now() - ttsStart;
        sseEvent(res, "audio", {
          base64: ttsResult.audio.toString("base64"),
          format: ttsResult.format,
          ms: ttsMs,
          timings: ttsResult.timings,
        });
      }

      sseEvent(res, "done", { sttMs });
    } catch (e) {
      sseEvent(res, "error", { message: (e as Error).message });
    } finally {
      res.end();
    }
  });
}
