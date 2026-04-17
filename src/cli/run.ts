import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { loadMatrix, runMatrix } from "../core/runner.js";
import { readRuns } from "../core/jsonl.js";
import { toMarkdownSummary } from "../core/report.js";

async function main() {
  const matrixPath = process.argv[2];
  if (!matrixPath) {
    console.error("usage: autobench run <matrix.yaml> [--out runs/<name>.jsonl]");
    process.exit(1);
  }
  const outIdx = process.argv.indexOf("--out");
  const runsPath = resolve(
    outIdx >= 0 && process.argv[outIdx + 1]
      ? process.argv[outIdx + 1]!
      : `runs/run-${Date.now()}.jsonl`
  );
  const absolute = resolve(matrixPath);
  const matrix = await loadMatrix(absolute);
  console.log(`▸ matrix: ${absolute}`);
  console.log(`▸ writing: ${runsPath}`);

  for await (const evt of runMatrix(matrix, { runsPath })) {
    if (evt.type === "start") {
      const p = evt.pipeline;
      const parts = [
        p.vad?.name,
        p.stt?.name,
        p.llm?.name,
        p.tts?.name,
      ].filter(Boolean).join(" → ");
      process.stdout.write(`  ▸ [${evt.caseId}] ${parts}… `);
    } else if (evt.type === "record") {
      const m = evt.record.metrics;
      const bits = [
        m.ttftMs && `ttft ${m.ttftMs.toFixed(0)}ms`,
        m.tps && `${m.tps.toFixed(1)} tok/s`,
        m.firstAudioMs && `audio ${m.firstAudioMs.toFixed(0)}ms`,
        m.totalMs && `total ${m.totalMs.toFixed(0)}ms`,
      ].filter(Boolean).join("  ");
      console.log(bits);
    } else if (evt.type === "error") {
      console.log(`✗ ${evt.message}`);
    } else if (evt.type === "done") {
      console.log(`\n▸ done: ${evt.totalRuns} run(s)`);
    }
  }

  const records = await readRuns(runsPath);
  const md = toMarkdownSummary(records);
  const summaryPath = runsPath.replace(/\.jsonl$/, ".summary.md");
  await writeFile(summaryPath, md);
  console.log(`▸ summary: ${summaryPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
