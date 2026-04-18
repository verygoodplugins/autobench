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
  app.use("/playground", express.json({ limit: "25mb" }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/plugins", (_req, res) => {
    res.json(registry.describe());
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
  });
}
