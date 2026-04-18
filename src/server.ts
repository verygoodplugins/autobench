import express from "express";
import cors from "cors";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadBuiltins, registry } from "./core/registry.js";
import { loadMatrix, runMatrix } from "./core/runner.js";
import { readRuns } from "./core/jsonl.js";
import { toMarkdownSummary } from "./core/report.js";
import { registerPlaygroundRoutes } from "./playground.js";

type ServerOptions = {
  port: number;
  runsDir?: string;
};

export async function startServer(opts: ServerOptions): Promise<void> {
  await loadBuiltins();
  const runsDir = resolve(opts.runsDir ?? "runs");
  const app = express();
  app.use(cors());
  const defaultJsonParser = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith("/playground")) return next();
    defaultJsonParser(req, res, next);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/plugins", (_req, res) => {
    res.json(registry.describe());
  });

  app.get("/ollama/models", async (_req, res) => {
    try {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const r = await fetch(`${baseUrl}/api/tags`);
      if (!r.ok) {
        res.status(502).json({ error: `ollama ${r.status}` });
        return;
      }
      const data = (await r.json()) as { models?: { name: string }[] };
      const models = (data.models ?? [])
        .map((m) => m.name)
        .sort((a, b) => a.localeCompare(b));
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.get("/runs", async (_req, res) => {
    try {
      const files = (await readdir(runsDir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
      const out: { file: string; records: number; summary: string }[] = [];
      for (const file of files) {
        const records = await readRuns(join(runsDir, file));
        out.push({
          file,
          records: records.length,
          summary: toMarkdownSummary(records),
        });
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/runs/:file", async (req, res) => {
    try {
      const file = req.params.file!;
      if (!/^[\w.\-]+\.jsonl$/.test(file)) {
        return res.status(400).json({ error: "invalid file name" });
      }
      const records = await readRuns(join(runsDir, file));
      res.json({ file, records });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/run/stream", async (req, res) => {
    const matrixPath = req.body?.matrix as string | undefined;
    if (!matrixPath) return res.status(400).json({ error: "missing matrix path" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const matrix = await loadMatrix(resolve(matrixPath));
      const runsPath = join(runsDir, `run-${Date.now()}.jsonl`);
      for await (const evt of runMatrix(matrix, { runsPath })) {
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    } catch (e) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`
      );
    } finally {
      res.end();
    }
  });

  registerPlaygroundRoutes(app);

  app.listen(opts.port, () => {
    console.log(`▸ autobench server listening on http://localhost:${opts.port}`);
    console.log(`▸ runs directory: ${runsDir}`);
    probeBackends().catch(() => undefined);
  });
}

async function probeBackends(): Promise<void> {
  const backends = [
    {
      label: "ollama",
      url: `${process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/api/tags`,
    },
    {
      label: "parakeet-server (STT)",
      url: `${process.env.PARAKEET_SERVER_URL ?? "http://localhost:8179"}/health`,
      hint: "set PARAKEET_SERVER_URL or start parakeet-server on :8179",
    },
    {
      label: "whisper-server (STT)",
      url: `${process.env.WHISPER_SERVER_URL ?? "http://localhost:8178"}/health`,
      hint: "set WHISPER_SERVER_URL or start whisper-server on :8178",
    },
  ];
  for (const b of backends) {
    const ok = await reachable(b.url);
    const status = ok ? "ok" : "NOT REACHABLE";
    const hint = !ok && b.hint ? ` — ${b.hint}` : "";
    console.log(`▸ ${b.label.padEnd(22)} ${b.url.padEnd(40)} ${status}${hint}`);
  }
}

async function reachable(url: string, timeoutMs = 800): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
