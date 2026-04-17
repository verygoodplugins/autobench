import { pipelineKey, percentile } from "../lib";
import type { RunRecord } from "../types";

type Metric = "ttftMs" | "tps" | "firstAudioMs" | "totalMs";

export function Leaderboard({
  records,
  metric,
}: {
  records: RunRecord[];
  metric: Metric;
}) {
  const groups = new Map<string, number[]>();
  for (const r of records) {
    const v = r.metrics[metric];
    if (v == null || !Number.isFinite(v)) continue;
    const key = pipelineKey(r);
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }

  const rows = Array.from(groups).map(([key, values]) => ({
    key,
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  }));

  const desc = metric === "tps";
  rows.sort((a, b) => (desc ? b.p50 - a.p50 : a.p50 - b.p50));

  return (
    <table>
      <thead>
        <tr>
          <th>pipeline</th>
          <th className="num">n</th>
          <th className="num">p50</th>
          <th className="num">p95</th>
          <th className="num">p99</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td className="num">{r.n}</td>
            <td className="num">{r.p50.toFixed(1)}</td>
            <td className="num">{r.p95.toFixed(1)}</td>
            <td className="num">{r.p99.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
