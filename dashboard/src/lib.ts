import type { RunRecord } from "./types";

export function pipelineKey(r: RunRecord): string {
  const llmModel = r.pipeline.llm?.config?.["model"];
  const llm = r.pipeline.llm
    ? `${r.pipeline.llm.name}${llmModel ? `(${llmModel})` : ""}`
    : "-";
  return [
    r.pipeline.vad?.name ?? "-",
    r.pipeline.stt?.name ?? "-",
    llm,
    r.pipeline.tts?.name ?? "-",
  ].join(" → ");
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
