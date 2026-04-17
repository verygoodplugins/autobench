import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

export type HardwareSnapshot = {
  machine: string;
  platform: string;
  totalMemoryGb: number;
  memoryPressure: string | null;
  processResidentGb: number | null;
};

export async function sampleHardware(
  processName?: string
): Promise<HardwareSnapshot> {
  const platform = process.platform;
  const machine = os.hostname();
  const totalMemoryGb = os.totalmem() / 1024 / 1024 / 1024;

  let memoryPressure: string | null = null;
  let processResidentGb: number | null = null;

  if (platform === "darwin") {
    memoryPressure = await macMemoryPressure();
    if (processName) processResidentGb = await macProcessRssGb(processName);
  }

  return {
    machine,
    platform,
    totalMemoryGb: Number(totalMemoryGb.toFixed(2)),
    memoryPressure,
    processResidentGb,
  };
}

async function macMemoryPressure(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("memory_pressure", [], {
      timeout: 2000,
    });
    const match = stdout.match(/System-wide memory free percentage: (\d+)%/);
    if (!match) return null;
    const freePct = Number(match[1]);
    if (freePct > 40) return "normal";
    if (freePct > 15) return "warn";
    return "critical";
  } catch {
    return null;
  }
}

async function macProcessRssGb(name: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "bash",
      [
        "-lc",
        `ps -axo rss=,comm= | awk -v n='${name}' '$2 ~ n { sum += $1 } END { print sum }'`,
      ],
      { timeout: 2000 }
    );
    const kb = Number(stdout.trim());
    if (!Number.isFinite(kb) || kb <= 0) return null;
    return Number((kb / 1024 / 1024).toFixed(2));
  } catch {
    return null;
  }
}
