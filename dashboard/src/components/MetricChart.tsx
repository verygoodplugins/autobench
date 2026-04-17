import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { pipelineKey } from "../lib";
import type { RunRecord } from "../types";

type Props = {
  records: RunRecord[];
  metric: "ttftMs" | "tps" | "firstAudioMs" | "totalMs";
};

export function MetricChart({ records, metric }: Props) {
  const groups = new Map<string, { x: number; y: number }[]>();
  for (const r of records) {
    const key = pipelineKey(r);
    const v = r.metrics[metric];
    if (v == null || !Number.isFinite(v)) continue;
    const ts = new Date(r.ts).getTime();
    const list = groups.get(key) ?? [];
    list.push({ x: ts, y: v });
    groups.set(key, list);
  }

  const palette = [
    "#7dd3fc", "#fca5a5", "#86efac", "#fcd34d", "#c4b5fd",
    "#f9a8d4", "#fdba74", "#67e8f9", "#a3e635",
  ];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 40 }}>
        <CartesianGrid stroke="#1f2328" />
        <XAxis
          type="number"
          dataKey="x"
          domain={["auto", "auto"]}
          tickFormatter={(v) => new Date(v).toLocaleTimeString()}
          stroke="#8a8f98"
        />
        <YAxis dataKey="y" stroke="#8a8f98" />
        <ZAxis range={[60, 60]} />
        <Tooltip
          contentStyle={{ background: "#0f1216", border: "1px solid #1f2328" }}
          labelFormatter={(v) => new Date(v as number).toLocaleString()}
        />
        <Legend />
        {Array.from(groups).map(([key, data], i) => (
          <Scatter
            key={key}
            name={key}
            data={data}
            fill={palette[i % palette.length]}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}
