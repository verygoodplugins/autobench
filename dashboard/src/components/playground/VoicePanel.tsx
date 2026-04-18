import { useEffect, useRef, useState } from "react";
import { postSse } from "../../lib/sse";
import { base64WavToObjectUrl, startRecorder, type Recorder } from "../../lib/audio";
import type { PipelineConfig } from "../../lib/pipeline";
import { buildLlmSlot } from "../../lib/pipeline";
import { PipelineEditor } from "./PipelineEditor";

type Registry = { vad: string[]; stt: string[]; llm: string[]; tts: string[] };

type Turn = {
  id: string;
  transcript?: string;
  llmText?: string;
  audioUrl?: string;
  sttMs?: number;
  llmTtftMs?: number;
  llmTotalMs?: number;
  ttsMs?: number;
  audioFormat?: string;
  error?: string;
};

type Props = {
  config: PipelineConfig;
  onConfigChange: (next: PipelineConfig) => void;
  registry: Registry | null;
};

export function VoicePanel({ config, onConfigChange, registry }: Props) {
  const [recording, setRecording] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  async function start() {
    if (recording || busy) return;
    setGlobalError(null);
    try {
      recorderRef.current = await startRecorder();
      setRecording(true);
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  }

  async function stopAndSend() {
    if (!recording || !recorderRef.current) return;
    setRecording(false);
    setBusy(true);
    const rec = recorderRef.current;
    recorderRef.current = null;

    const turnId = crypto.randomUUID();
    setTurns((t) => [...t, { id: turnId }]);

    let wavBase64: string;
    let durationMs: number;
    try {
      const out = await rec.stop();
      wavBase64 = out.wavBase64;
      durationMs = out.durationMs;
    } catch (e) {
      patchTurn(turnId, { error: (e as Error).message });
      setBusy(false);
      return;
    }

    if (durationMs < 200) {
      patchTurn(turnId, { error: "recording too short (<200ms)" });
      setBusy(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body: Record<string, unknown> = {
        stt: { name: config.stt.name },
        llm: buildLlmSlot(config.llm),
        audio: wavBase64,
        audioFormat: "wav",
      };
      if (config.tts.enabled) body.tts = { name: config.tts.name };
      if (config.system.trim()) body.system = config.system.trim();

      for await (const evt of postSse("/playground/voice/turn", body, controller.signal)) {
        if (evt.event === "transcript") {
          const d = evt.data as { text: string; ms: number };
          patchTurn(turnId, { transcript: d.text, sttMs: d.ms });
        } else if (evt.event === "token") {
          const d = evt.data as { text: string; timings?: Record<string, number> };
          setTurns((ts) =>
            ts.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    llmText: (t.llmText ?? "") + d.text,
                    llmTtftMs: t.llmTtftMs ?? d.timings?.ttftMs,
                    llmTotalMs: d.timings?.totalMs ?? t.llmTotalMs,
                  }
                : t
            )
          );
        } else if (evt.event === "llm-done") {
          const d = evt.data as {
            text: string;
            timings?: Record<string, number>;
          };
          patchTurn(turnId, {
            llmText: d.text,
            llmTotalMs: d.timings?.totalMs,
          });
        } else if (evt.event === "audio") {
          const d = evt.data as { base64: string; format: string; ms: number };
          const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", pcm16: "audio/pcm" };
          const mimeType = MIME[d.format] ?? `audio/${d.format}`;
          const url = base64WavToObjectUrl(d.base64, mimeType);
          audioUrlsRef.current.push(url);
          patchTurn(turnId, { audioUrl: url, ttsMs: d.ms, audioFormat: d.format });
        } else if (evt.event === "error") {
          const d = evt.data as { message: string };
          patchTurn(turnId, { error: d.message });
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patchTurn(turnId, { error: (e as Error).message });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    if (recording) {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
      return;
    }
    abortRef.current?.abort();
  }

  function patchTurn(id: string, patch: Partial<Turn>) {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function reset() {
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlsRef.current = [];
    setTurns([]);
    setGlobalError(null);
  }

  return (
    <div className="chat-panel">
      <PipelineEditor
        config={config}
        onChange={onConfigChange}
        registry={registry}
        mode="voice"
        disabled={busy || recording}
      />

      <div className="ptt-row">
        {!recording && !busy && (
          <button className="ptt-btn" onClick={start}>
            ● start mic
          </button>
        )}
        {recording && (
          <>
            <button className="ptt-btn ptt-btn-stop" onClick={stopAndSend}>
              ■ send
            </button>
            <button onClick={cancel}>cancel</button>
            <span className="muted">recording…</span>
          </>
        )}
        {busy && (
          <>
            <span className="muted">processing turn…</span>
            <button onClick={cancel}>abort</button>
          </>
        )}
        <button onClick={reset} disabled={busy || recording || turns.length === 0} style={{ marginLeft: "auto" }}>
          reset
        </button>
      </div>

      {globalError && <div className="chat-error">error: {globalError}</div>}

      <div className="chat-log">
        {turns.length === 0 && (
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            click "start mic", speak, then "send". tts = macos-say avoids kokoro's current ONNX error.
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            <div className="turn-metrics">
              {t.sttMs != null && <span>stt {t.sttMs.toFixed(0)}ms</span>}
              {t.llmTtftMs != null && <span>ttft {t.llmTtftMs.toFixed(0)}ms</span>}
              {t.llmTotalMs != null && <span>llm {t.llmTotalMs.toFixed(0)}ms</span>}
              {t.ttsMs != null && <span>tts {t.ttsMs.toFixed(0)}ms</span>}
            </div>
            {t.transcript != null && (
              <div className="chat-msg chat-msg-user">
                <div className="chat-role">you</div>
                <div className="chat-content">{t.transcript || "(empty)"}</div>
              </div>
            )}
            {t.llmText != null && (
              <div className="chat-msg chat-msg-assistant">
                <div className="chat-role">assistant</div>
                <div className="chat-content">{t.llmText}</div>
              </div>
            )}
            {t.audioUrl && (
              <audio
                controls
                autoPlay
                src={t.audioUrl}
                style={{ width: "100%", marginTop: "0.25rem" }}
              />
            )}
            {t.error && <div className="chat-error">turn error: {t.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
