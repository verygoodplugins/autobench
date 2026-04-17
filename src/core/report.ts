import { summaryStats } from "./metrics.js";
import type { RunRecord } from "./types.js";

export function pipelineKey(r: RunRecord): string {
  const parts = [
    r.pipeline.vad?.name ?? "-",
    r.pipeline.stt?.name ?? "-",
    `${r.pipeline.llm?.name ?? "-"}${r.pipeline.llm?.config?.["model"] ? `(${r.pipeline.llm?.config?.["model"]})` : ""}`,
    r.pipeline.tts?.name ?? "-",
  ];
  return parts.join(" → ");
}

export function toMarkdownSummary(records: RunRecord[]): string {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = pipelineKey(r);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const rows: string[] = [];
  rows.push("# autobench summary");
  rows.push("");
  rows.push(`_${records.length} runs across ${groups.size} pipelines_`);
  rows.push("");
  rows.push("| pipeline | n | TTFT p50 | TTFT p95 | TPS p50 | first-audio p50 | total p50 |");
  rows.push("|---|---:|---:|---:|---:|---:|---:|");

  for (const [key, rs] of groups) {
    const ttft = summaryStats(rs.map((r) => r.metrics.ttftMs).filter((v): v is number => !!v));
    const tps = summaryStats(rs.map((r) => r.metrics.tps).filter((v): v is number => !!v));
    const firstAudio = summaryStats(rs.map((r) => r.metrics.firstAudioMs).filter((v): v is number => !!v));
    const total = summaryStats(rs.map((r) => r.metrics.totalMs).filter((v): v is number => !!v));

    const fmt = (v: number, unit: string) =>
      Number.isFinite(v) ? `${v.toFixed(1)}${unit}` : "—";

    rows.push(
      `| ${key} | ${rs.length} | ${fmt(ttft.p50, "ms")} | ${fmt(ttft.p95, "ms")} | ${fmt(tps.p50, " tok/s")} | ${fmt(firstAudio.p50, "ms")} | ${fmt(total.p50, "ms")} |`
    );
  }
  rows.push("");
  return rows.join("\n");
}
