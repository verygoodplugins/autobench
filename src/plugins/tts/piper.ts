import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "../../core/registry.js";
import type { TtsPlugin } from "../../core/types.js";

type PiperConfig = {
  binary?: string;
  model: string;
  modelConfig?: string;
  speaker?: number;
  lengthScale?: number;
};

class PiperPlugin implements TtsPlugin<PiperConfig> {
  readonly kind = "tts" as const;
  readonly name = "piper";
  readonly description =
    "Piper TTS via CLI. Batch mode — firstAudioMs == totalMs. Requires `piper` binary + voice .onnx. Uses rhasspy/piper C++ flag syntax (--output_file, --length_scale); Python piper-tts uses hyphens — override via config.binary if needed.";

  private binary = "piper";
  private model = "";
  private modelConfig?: string;
  private speaker?: number;
  private lengthScale?: number;

  async init(config: PiperConfig): Promise<void> {
    if (!config.model) {
      throw new Error("piper plugin requires `model` (path to .onnx voice)");
    }
    this.model = config.model;
    if (config.binary) this.binary = config.binary;
    if (config.modelConfig) this.modelConfig = config.modelConfig;
    if (config.speaker !== undefined) this.speaker = config.speaker;
    if (config.lengthScale !== undefined) this.lengthScale = config.lengthScale;
  }

  async synthesize(text: string): Promise<{
    audio: Buffer;
    format: "wav";
    timings: Record<string, number>;
    metadata?: Record<string, unknown>;
  }> {
    const started = performance.now();
    const dir = await mkdtemp(join(tmpdir(), "autobench-piper-"));
    const outPath = join(dir, "out.wav");

    const args = ["--model", this.model, "--output_file", outPath];
    if (this.modelConfig) args.push("--config", this.modelConfig);
    if (this.speaker !== undefined) args.push("--speaker", String(this.speaker));
    if (this.lengthScale !== undefined)
      args.push("--length_scale", String(this.lengthScale));

    try {
      await runPiper(this.binary, args, text);
      const audio = await readFile(outPath);
      const now = performance.now();
      return {
        audio,
        format: "wav",
        timings: {
          firstAudioMs: now - started,
          totalMs: now - started,
        },
        metadata: {
          model: this.model,
          speaker: this.speaker,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function runPiper(binary: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) =>
      reject(new Error(`piper spawn failed: ${err.message}`))
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.stdin.end(text);
  });
}

registry.register("tts", "piper", async () => new PiperPlugin());
