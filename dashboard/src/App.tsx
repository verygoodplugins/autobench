import { useEffect, useMemo, useState } from "react";
import { RunsTable } from "./components/RunsTable";
import { MetricChart } from "./components/MetricChart";
import { Leaderboard } from "./components/Leaderboard";
import type { RunFile, RunFileDetail, RunRecord } from "./types";

type Metric = "ttftMs" | "tps" | "firstAudioMs" | "totalMs";

export function App() {
  const [files, setFiles] = useState<RunFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [metric, setMetric] = useState<Metric>("ttftMs");
  const [pluginFilter, setPluginFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/runs")
      .then((r) => r.json())
      .then((data: RunFile[]) => {
        setFiles(data);
        if (data.length) setActiveFile(data[data.length - 1]!.file);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!activeFile) return;
    fetch(`/runs/${encodeURIComponent(activeFile)}`)
      .then((r) => r.json())
      .then((detail: RunFileDetail) => setRecords(detail.records))
      .catch((e) => setError(String(e)));
  }, [activeFile]);

  const plugins = useMemo(() => {
    const names = new Set<string>();
    for (const r of records) {
      if (r.pipeline.llm) names.add(`llm:${r.pipeline.llm.name}`);
      if (r.pipeline.stt) names.add(`stt:${r.pipeline.stt.name}`);
      if (r.pipeline.tts) names.add(`tts:${r.pipeline.tts.name}`);
      if (r.pipeline.vad) names.add(`vad:${r.pipeline.vad.name}`);
    }
    return Array.from(names).sort();
  }, [records]);

  const filtered = useMemo(() => {
    if (pluginFilter === "all") return records;
    const [slot, name] = pluginFilter.split(":");
    return records.filter((r) => {
      const p = (r.pipeline as Record<string, { name: string } | undefined>)[slot!];
      return p?.name === name;
    });
  }, [records, pluginFilter]);

  return (
    <>
      <header>
        <h1>
          <span className="tag">autobench</span> — local voice/chat pipeline lab
        </h1>
        <span className="muted">
          {files.length} run file{files.length === 1 ? "" : "s"}
          {records.length > 0 && ` · ${records.length} records`}
        </span>
      </header>
      <main>
        {error && <section style={{ color: "#ff6b6b" }}>{error}</section>}

        <section>
          <div className="row">
            <label>
              file&nbsp;
              <select
                value={activeFile ?? ""}
                onChange={(e) => setActiveFile(e.target.value || null)}
              >
                <option value="">—</option>
                {files.map((f) => (
                  <option key={f.file} value={f.file}>
                    {f.file} ({f.records})
                  </option>
                ))}
              </select>
            </label>
            <label>
              metric&nbsp;
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as Metric)}
              >
                <option value="ttftMs">TTFT (ms)</option>
                <option value="tps">tokens/s</option>
                <option value="firstAudioMs">first-audio (ms)</option>
                <option value="totalMs">total (ms)</option>
              </select>
            </label>
            <label>
              filter&nbsp;
              <select
                value={pluginFilter}
                onChange={(e) => setPluginFilter(e.target.value)}
              >
                <option value="all">all pipelines</option>
                {plugins.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {filtered.length === 0 ? (
          <section className="empty">
            no records — run <code>npm run bench configs/m5-max.yaml</code> then refresh
          </section>
        ) : (
          <>
            <section>
              <h2>{metric}</h2>
              <MetricChart records={filtered} metric={metric} />
            </section>
            <section>
              <h2>leaderboard</h2>
              <Leaderboard records={filtered} metric={metric} />
            </section>
            <section>
              <h2>runs</h2>
              <RunsTable records={filtered} />
            </section>
          </>
        )}
      </main>
    </>
  );
}
