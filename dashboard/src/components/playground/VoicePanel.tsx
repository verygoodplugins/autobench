import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "../../lib/sse";
import {
  base64WavToObjectUrl,
  startRecorder,
  startVadRecorder,
  type Recorder,
  type VadRecorder,
} from "../../lib/audio";
import type { PipelineConfig } from "../../lib/pipeline";
import { buildLlmSlot } from "../../lib/pipeline";
import { PipelineEditor } from "./PipelineEditor";

type Registry = { vad: string[]; stt: string[]; llm: string[]; tts: string[] };

type Mode = "ptt" | "hands-free";
type VadStatus =
  | "idle"
  | "loading"
  | "listening"
  | "speaking"
  | "processing"
  | "playing";

// Delay after TTS playback starts before we treat a VAD speech-start as
// barge-in. TTS audio bleeds into the mic before browser AEC adapts; the
// sibling voice-server used 250ms. Browser AEC is slightly slower to adapt.
const BARGE_IN_ARM_DELAY_MS = 300;
const MIN_SEND_MS = 200;

type Turn = {
  id: string;
  transcript?: string;
  llmText?: string;
  audioUrls: string[];
  sttMs?: number;
  llmTtftMs?: number;
  llmTotalMs?: number;
  firstAudioMs?: number;
  audioFormat?: string;
  segments?: number;
  error?: string;
};

type Props = {
  config: PipelineConfig;
  onConfigChange: (next: PipelineConfig) => void;
  registry: Registry | null;
};

export function VoicePanel({ config, onConfigChange, registry }: Props) {
  const [mode, setMode] = useState<Mode>("ptt");
  const [recording, setRecording] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [vadStatus, setVadStatus] = useState<VadStatus>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const recorderRef = useRef<Recorder | null>(null);
  const vadRef = useRef<VadRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioUrlsRef = useRef<string[]>([]);
  const currentAudioElRef = useRef<HTMLAudioElement | null>(null);
  const playbackQueueRef = useRef<string[]>([]);
  const playbackHandsFreeRef = useRef<boolean>(false);
  const playbackArmedAtRef = useRef<number | null>(null);
  const vadStatusRef = useRef<VadStatus>("idle");
  const modeRef = useRef<Mode>("ptt");

  // Keep refs in sync so async callbacks (VAD events) see current values
  useEffect(() => { vadStatusRef.current = vadStatus; }, [vadStatus]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    return () => {
      audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      vadRef.current?.destroy();
      recorderRef.current?.cancel();
      stopCurrentPlayback();
    };
  }, []);

  const patchTurn = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  function stopCurrentPlayback() {
    playbackQueueRef.current = [];
    const el = currentAudioElRef.current;
    if (el) {
      try {
        el.pause();
        el.src = "";
      } catch {
        // ignore — element may already be detached
      }
    }
    currentAudioElRef.current = null;
    playbackArmedAtRef.current = null;
  }

  function queuePlayback(url: string, handsFree: boolean) {
    playbackQueueRef.current.push(url);
    playbackHandsFreeRef.current = handsFree;
    if (!currentAudioElRef.current) playNextFromQueue();
  }

  function playNextFromQueue() {
    const url = playbackQueueRef.current.shift();
    if (!url) {
      // Queue drained. If we were tracking VAD state, return to listening.
      if (
        playbackHandsFreeRef.current &&
        modeRef.current === "hands-free" &&
        vadStatusRef.current === "playing"
      ) {
        setVadStatus("listening");
      }
      playbackArmedAtRef.current = null;
      return;
    }
    const el = new Audio(url);
    currentAudioElRef.current = el;
    el.onplay = () => {
      playbackArmedAtRef.current = performance.now();
      if (
        playbackHandsFreeRef.current &&
        modeRef.current === "hands-free" &&
        vadStatusRef.current !== "playing"
      ) {
        setVadStatus("playing");
      }
    };
    const advance = () => {
      if (currentAudioElRef.current === el) currentAudioElRef.current = null;
      playNextFromQueue();
    };
    el.onended = advance;
    el.onerror = advance;
    el.play().catch((err) => {
      console.warn("[voice] playback failed", err);
      advance();
    });
  }

  function buildRequestBody(wavBase64: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      stt: { name: config.stt.name },
      llm: buildLlmSlot(config.llm),
      audio: wavBase64,
      audioFormat: "wav",
    };
    if (config.tts.enabled) body.tts = { name: config.tts.name };
    if (config.system.trim()) body.system = config.system.trim();
    return body;
  }

  // Core turn pipeline — shared by PTT send + hands-free speech-end.
  // Streams the SSE response and returns whether the server produced TTS audio.
  async function runTurn(
    turnId: string,
    wavBase64: string,
    handsFree: boolean
  ): Promise<{ gotAudio: boolean; aborted: boolean }> {
    const controller = new AbortController();
    abortRef.current = controller;

    let gotAudio = false;
    let aborted = false;
    try {
      for await (const evt of postSse(
        "/playground/voice/turn",
        buildRequestBody(wavBase64),
        controller.signal
      )) {
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
          const d = evt.data as {
            base64: string;
            format: string;
            ms: number;
            index?: number;
          };
          const MIME: Record<string, string> = {
            mp3: "audio/mpeg",
            wav: "audio/wav",
            pcm16: "audio/pcm",
          };
          const mimeType = MIME[d.format] ?? `audio/${d.format}`;
          const url = base64WavToObjectUrl(d.base64, mimeType);
          audioUrlsRef.current.push(url);
          setTurns((ts) =>
            ts.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    audioUrls: [...t.audioUrls, url],
                    firstAudioMs: t.firstAudioMs ?? d.ms,
                    audioFormat: d.format,
                  }
                : t
            )
          );
          gotAudio = true;
          queuePlayback(url, handsFree);
        } else if (evt.event === "tts-error") {
          const d = evt.data as { message: string; text?: string };
          console.warn("[voice] tts segment error:", d.message, d.text);
        } else if (evt.event === "error") {
          const d = evt.data as { message: string };
          patchTurn(turnId, { error: d.message });
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        aborted = true;
      } else {
        patchTurn(turnId, { error: (e as Error).message });
      }
    } finally {
      abortRef.current = null;
    }
    return { gotAudio, aborted };
  }

  // -------------------- PTT mode --------------------

  async function startPtt() {
    if (recording || busy) return;
    setGlobalError(null);
    try {
      recorderRef.current = await startRecorder();
      setRecording(true);
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  }

  async function stopAndSendPtt() {
    if (!recording || !recorderRef.current) return;
    setRecording(false);
    setBusy(true);
    const rec = recorderRef.current;
    recorderRef.current = null;

    const turnId = crypto.randomUUID();
    setTurns((t) => [...t, { id: turnId, audioUrls: [] }]);

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

    if (durationMs < MIN_SEND_MS) {
      patchTurn(turnId, { error: `recording too short (<${MIN_SEND_MS}ms)` });
      setBusy(false);
      return;
    }

    await runTurn(turnId, wavBase64, false);
    setBusy(false);
  }

  function cancelPtt() {
    if (recording) {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
      return;
    }
    abortRef.current?.abort();
  }

  // -------------------- Hands-free mode --------------------

  async function startHandsFree() {
    if (vadStatus !== "idle") return;
    setGlobalError(null);
    setVadStatus("loading");
    try {
      vadRef.current = await startVadRecorder({
        onSpeechStart: () => {
          const status = vadStatusRef.current;
          // Barge-in: speech detected during TTS playback after arm-delay
          if (
            status === "playing" &&
            playbackArmedAtRef.current !== null &&
            performance.now() - playbackArmedAtRef.current > BARGE_IN_ARM_DELAY_MS
          ) {
            stopCurrentPlayback();
            abortRef.current?.abort();
            setVadStatus("speaking");
            return;
          }
          if (status === "listening") {
            setVadStatus("speaking");
          }
          // During "processing" we stay processing — the VAD will buffer the
          // new utterance and deliver it via onSpeechEnd once ready. The next
          // speech-end will fire handleSpeechEnd which handles ordering.
        },
        onSpeechEnd: (wavBase64, durationMs) => {
          void handleSpeechEnd(wavBase64, durationMs);
        },
        onMisfire: () => {
          if (vadStatusRef.current === "speaking") setVadStatus("listening");
        },
        onError: (err) => {
          setGlobalError(err.message);
        },
      });
      setVadStatus("listening");
    } catch (e) {
      setGlobalError((e as Error).message);
      setVadStatus("idle");
    }
  }

  async function handleSpeechEnd(wavBase64: string, durationMs: number) {
    if (durationMs < MIN_SEND_MS) {
      if (vadStatusRef.current !== "idle") setVadStatus("listening");
      return;
    }
    setVadStatus("processing");
    const turnId = crypto.randomUUID();
    setTurns((t) => [...t, { id: turnId, audioUrls: [] }]);

    const { gotAudio, aborted } = await runTurn(turnId, wavBase64, true);

    // If the turn was aborted (barge-in triggered it), we're already in
    // "speaking" — don't stomp the state. Otherwise, a turn with TTS audio
    // will transition via onplay/onended; a turn with no TTS returns to
    // listening now.
    if (modeRef.current !== "hands-free") return;
    if (aborted) return;
    if (!gotAudio) setVadStatus("listening");
  }

  function stopHandsFree() {
    stopCurrentPlayback();
    abortRef.current?.abort();
    vadRef.current?.destroy();
    vadRef.current = null;
    setVadStatus("idle");
  }

  // -------------------- Mode switching --------------------

  function switchMode(next: Mode) {
    if (next === mode) return;
    // Tear down whichever mode's resources are live
    if (mode === "ptt") {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
      abortRef.current?.abort();
      setBusy(false);
    } else {
      stopHandsFree();
    }
    setMode(next);
  }

  function reset() {
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlsRef.current = [];
    setTurns([]);
    setGlobalError(null);
  }

  // -------------------- Render --------------------

  const editorDisabled =
    busy || recording || (mode === "hands-free" && vadStatus !== "idle");

  return (
    <div className="chat-panel">
      <PipelineEditor
        config={config}
        onChange={onConfigChange}
        registry={registry}
        mode="voice"
        disabled={editorDisabled}
      />

      <div className="ptt-row">
        <div className="mode-toggle" role="tablist" aria-label="voice mode">
          <button
            role="tab"
            aria-selected={mode === "ptt"}
            className={mode === "ptt" ? "mode-btn mode-btn-active" : "mode-btn"}
            onClick={() => switchMode("ptt")}
            disabled={editorDisabled}
          >
            push-to-talk
          </button>
          <button
            role="tab"
            aria-selected={mode === "hands-free"}
            className={
              mode === "hands-free" ? "mode-btn mode-btn-active" : "mode-btn"
            }
            onClick={() => switchMode("hands-free")}
            disabled={editorDisabled}
          >
            hands-free (vad)
          </button>
        </div>

        {mode === "ptt" ? (
          <>
            {!recording && !busy && (
              <button className="ptt-btn" onClick={startPtt}>
                ● start mic
              </button>
            )}
            {recording && (
              <>
                <button className="ptt-btn ptt-btn-stop" onClick={stopAndSendPtt}>
                  ■ send
                </button>
                <button onClick={cancelPtt}>cancel</button>
                <span className="muted">recording…</span>
              </>
            )}
            {busy && (
              <>
                <span className="muted">processing turn…</span>
                <button onClick={cancelPtt}>abort</button>
              </>
            )}
          </>
        ) : (
          <>
            {vadStatus === "idle" && (
              <button className="ptt-btn" onClick={startHandsFree}>
                ● start listening
              </button>
            )}
            {vadStatus === "loading" && <span className="muted">loading VAD…</span>}
            {vadStatus !== "idle" && vadStatus !== "loading" && (
              <>
                <button className="ptt-btn ptt-btn-stop" onClick={stopHandsFree}>
                  ■ stop
                </button>
                <span className={`vad-pill vad-pill-${vadStatus}`}>{vadStatus}</span>
              </>
            )}
          </>
        )}

        <button
          onClick={reset}
          disabled={busy || recording || vadStatus !== "idle" || turns.length === 0}
          style={{ marginLeft: "auto" }}
        >
          reset
        </button>
      </div>

      {globalError && <div className="chat-error">error: {globalError}</div>}

      <div className="chat-log">
        {turns.length === 0 && (
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            {mode === "ptt"
              ? 'click "start mic", speak, then "send". tts = macos-say avoids kokoro\'s current ONNX error.'
              : 'click "start listening" — VAD auto-detects when you speak, auto-sends on silence, and lets you interrupt TTS by talking over it.'}
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            <div className="turn-metrics">
              {t.sttMs != null && <span>stt {t.sttMs.toFixed(0)}ms</span>}
              {t.llmTtftMs != null && <span>ttft {t.llmTtftMs.toFixed(0)}ms</span>}
              {t.llmTotalMs != null && <span>llm {t.llmTotalMs.toFixed(0)}ms</span>}
              {t.firstAudioMs != null && (
                <span>audio₁ {t.firstAudioMs.toFixed(0)}ms</span>
              )}
              {t.audioUrls.length > 1 && (
                <span>{t.audioUrls.length} segments</span>
              )}
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
            {t.audioUrls.length > 0 && (
              <div className="audio-segments">
                {t.audioUrls.map((url, i) => (
                  <audio
                    key={`${t.id}-${i}`}
                    controls
                    src={url}
                    style={{ width: "100%", marginTop: "0.25rem" }}
                  />
                ))}
              </div>
            )}
            {t.error && <div className="chat-error">turn error: {t.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
