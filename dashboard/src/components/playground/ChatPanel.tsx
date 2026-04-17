import { useEffect, useRef, useState } from "react";
import { postSse } from "../../lib/sse";

type Registry = { vad: string[]; stt: string[]; llm: string[]; tts: string[] };

type Message = { role: "system" | "user" | "assistant"; content: string };

type Metrics = {
  ttftMs?: number;
  totalMs?: number;
  completionTokens?: number;
  promptTokens?: number;
  tps?: number;
};

const MODEL_DEFAULTS: Record<string, string> = {
  ollama: "qwen2.5-coder:32b",
  claude: "claude-haiku-4-5",
};

export function ChatPanel({ registry }: { registry: Registry | null }) {
  const [llmName, setLlmName] = useState<string>("ollama");
  const [model, setModel] = useState<string>("");
  const [temperature, setTemperature] = useState<string>("0.7");
  const [maxTokens, setMaxTokens] = useState<string>("512");
  const [system, setSystem] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string>("");
  const [metrics, setMetrics] = useState<Metrics>({});
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setModel(MODEL_DEFAULTS[llmName] ?? "");
  }, [llmName]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, streaming]);

  async function send() {
    if (!input.trim() || busy) return;
    setError(null);
    setMetrics({});

    const userMsg: Message = { role: "user", content: input.trim() };
    const history: Message[] = system.trim()
      ? [{ role: "system", content: system.trim() }, ...messages, userMsg]
      : [...messages, userMsg];

    setMessages((m) => [...m, userMsg]);
    setInput("");
    setStreaming("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let acc = "";
      const body = {
        llm: {
          name: llmName,
          config: {
            model,
            ...(llmName === "ollama"
              ? {
                  temperature: Number(temperature) || undefined,
                  numPredict: Number(maxTokens) || undefined,
                }
              : {
                  temperature: Number(temperature) || undefined,
                  maxTokens: Number(maxTokens) || undefined,
                }),
          },
        },
        messages: history,
      };

      for await (const evt of postSse(
        "/playground/chat/stream",
        body,
        controller.signal
      )) {
        if (evt.event === "token") {
          const data = evt.data as { text: string; timings?: Record<string, number> };
          acc += data.text;
          setStreaming(acc);
          if (data.timings) {
            setMetrics((prev) => ({
              ...prev,
              ttftMs: prev.ttftMs ?? data.timings!.ttftMs,
              totalMs: data.timings!.totalMs,
            }));
          }
        } else if (evt.event === "done") {
          const data = evt.data as {
            timings?: Record<string, number>;
            metadata?: Record<string, unknown>;
          };
          const completionTokens = data.metadata?.completionTokens as number | undefined;
          const promptTokens = data.metadata?.promptTokens as number | undefined;
          const evalDurationMs = data.metadata?.evalDurationMs as number | undefined;
          const ttftMs = data.timings?.ttftMs;
          const totalMs = data.timings?.totalMs;
          let tps: number | undefined;
          if (completionTokens && evalDurationMs && evalDurationMs > 0) {
            tps = completionTokens / (evalDurationMs / 1000);
          } else if (completionTokens && totalMs && ttftMs !== undefined) {
            const gen = totalMs - ttftMs;
            if (gen > 0) tps = completionTokens / (gen / 1000);
          }
          setMetrics({ ttftMs, totalMs, completionTokens, promptTokens, tps });
        } else if (evt.event === "error") {
          const data = evt.data as { message: string };
          setError(data.message);
        }
      }
      if (acc) {
        setMessages((m) => [...m, { role: "assistant", content: acc }]);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
      }
    } finally {
      setStreaming("");
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    setMessages([]);
    setStreaming("");
    setMetrics({});
    setError(null);
  }

  const llmOptions = registry?.llm ?? ["ollama", "claude"];

  return (
    <div className="chat-panel">
      <div className="row">
        <label>
          llm&nbsp;
          <select
            value={llmName}
            onChange={(e) => setLlmName(e.target.value)}
            disabled={busy}
          >
            {llmOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          model&nbsp;
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            style={{ width: "16rem" }}
          />
        </label>
        <label>
          temp&nbsp;
          <input
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            disabled={busy}
            style={{ width: "3.5rem" }}
          />
        </label>
        <label>
          max tokens&nbsp;
          <input
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            disabled={busy}
            style={{ width: "4.5rem" }}
          />
        </label>
        <button onClick={reset} disabled={busy || messages.length === 0}>
          reset
        </button>
      </div>

      <details className="system-prompt">
        <summary>system prompt (optional)</summary>
        <textarea
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="you are a helpful assistant..."
        />
      </details>

      <div className="metrics-row">
        <span>
          TTFT:&nbsp;
          <b>{metrics.ttftMs != null ? `${metrics.ttftMs.toFixed(0)}ms` : "—"}</b>
        </span>
        <span>
          tok/s:&nbsp;
          <b>{metrics.tps != null ? metrics.tps.toFixed(1) : "—"}</b>
        </span>
        <span>
          tokens:&nbsp;
          <b>
            {metrics.promptTokens ?? "—"} in / {metrics.completionTokens ?? "—"} out
          </b>
        </span>
        <span>
          total:&nbsp;
          <b>{metrics.totalMs != null ? `${metrics.totalMs.toFixed(0)}ms` : "—"}</b>
        </span>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg-${m.role}`}>
            <div className="chat-role">{m.role}</div>
            <div className="chat-content">{m.content}</div>
          </div>
        ))}
        {streaming && (
          <div className="chat-msg chat-msg-assistant chat-msg-streaming">
            <div className="chat-role">assistant</div>
            <div className="chat-content">
              {streaming}
              <span className="cursor">▊</span>
            </div>
          </div>
        )}
      </div>

      {error && <div className="chat-error">error: {error}</div>}

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="type a message · ⌘↩ to send"
          rows={3}
          disabled={busy}
        />
        {busy ? (
          <button onClick={stop}>stop</button>
        ) : (
          <button onClick={send} disabled={!input.trim() || !model}>
            send
          </button>
        )}
      </div>
    </div>
  );
}
