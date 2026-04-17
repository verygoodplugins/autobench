import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunRecord } from "./types.js";

export class JsonlWriter {
  private stream: NodeJS.WritableStream;

  constructor(private readonly path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
  }

  append(record: RunRecord): void {
    this.stream.write(JSON.stringify(record) + "\n");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}

export async function readRuns(path: string): Promise<RunRecord[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);
}
