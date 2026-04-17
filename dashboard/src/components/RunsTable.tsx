import { pipelineKey } from "../lib";
import type { RunRecord } from "../types";

export function RunsTable({ records }: { records: RunRecord[] }) {
  const fmt = (v: number | undefined, unit = "") =>
    v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}${unit}`;

  return (
    <table>
      <thead>
        <tr>
          <th>time</th>
          <th>pipeline</th>
          <th className="num">TTFT</th>
          <th className="num">tok/s</th>
          <th className="num">audio</th>
          <th className="num">total</th>
          <th>error</th>
        </tr>
      </thead>
      <tbody>
        {records.slice(-200).reverse().map((r) => (
          <tr key={r.runId}>
            <td>{new Date(r.ts).toLocaleTimeString()}</td>
            <td>{pipelineKey(r)}</td>
            <td className="num">{fmt(r.metrics.ttftMs, "ms")}</td>
            <td className="num">{fmt(r.metrics.tps)}</td>
            <td className="num">{fmt(r.metrics.firstAudioMs, "ms")}</td>
            <td className="num">{fmt(r.metrics.totalMs, "ms")}</td>
            <td style={{ color: "#ff6b6b" }}>{r.error ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
