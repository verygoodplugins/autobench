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
import { DEFAULT_VOICE_PROMPT, buildLlmSlot } from "../../lib/pipeline";
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
const METER_BARS = 24;

type Turn = {
  id: string;
  transcript?: string;
  llmText?: string;
  streamingDone?: boolean;
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

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm16: "audio/pcm",
};

function vadPillLabel(s: VadStatus): string {
  switch (s) {
    case "idle": return "ready";
    case "loading": return "loading…";
    case "listening": return "listening";
    case "speaking": return "you're speaking";
    case "processing": return "thinking";
    case "playing": return "speaking";
  }
}

export function VoicePanel({ config, onConfigChange, registry }: Props) {
  const [mode, setMode] = useState<Mode>("ptt");
  const [recording, setRecording] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [vadStatus, setVadStatus] = useState<VadStatus>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [showMetrics, setShowMetrics] = useState<boolean>(false);

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

  // Mic-level meter
  const meterRef = useRef<HTMLDivElement | null>(null);
  const levelRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  // Chat log auto-scroll
  const logRef = useRef<HTMLDivElement | null>(null);

  // Keep refs in sync so async callbacks (VAD events) see current values
  useEffect(() => { vadStatusRef.current = vadStatus; }, [vadStatus]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    return () => {
      audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      vadRef.current?.destroy();
      recorderRef.current?.cancel();
      stopCurrentPlayback();
      stopMeter();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll chat log on any turn change (including mid-stream token append).
  // Instant scroll — smooth-behavior fights itself when tokens arrive every
  // ~50ms and ends up lagging behind the stream.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  const patchTurn = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // -------------------- Mic level meter --------------------

  function startMeter() {
    if (rafRef.current != null) return;
    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      const el = meterRef.current;
      if (!el) return;
      const now = performance.now();
      const level = levelRef.current;
      const bars = el.children;
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i] as HTMLElement;
        // Traveling sine wave so bars don't all move identically — looks alive.
        const phase = (i / bars.length) * Math.PI * 2 + now * 0.006;
        const mod = 0.5 + 0.5 * Math.sin(phase);
        const h = Math.max(0.08, 0.1 + level * (0.9 * mod + 0.1));
        bar.style.transform = `scaleY(${h.toFixed(3)})`;
      }
    };
    render();
  }

  function stopMeter() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    levelRef.current = 0;
    const el = meterRef.current;
    if (!el) return;
    const bars = el.children;
    for (let i = 0; i < bars.length; i++) {
      (bars[i] as HTMLElement).style.transform = "scaleY(0.08)";
    }
  }

  // -------------------- Playback queue --------------------

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

  // -------------------- Turn pipeline --------------------

  function buildRequestBody(wavBase64: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      stt: { name: config.stt.name },
      llm: buildLlmSlot(config.llm),
      audio: wavBase64,
      audioFormat: "wav",
    };
    if (config.tts.enabled) body.tts = { name: config.tts.name };
    if (config.voiceSystem.trim()) body.system = config.voiceSystem.trim();
    return body;
  }

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
          if (!d.text.trim()) {
            // Empty STT result — probably a VAD misfire or silent clip.
            // Drop the turn instead of showing a "(no speech detected)"
            // placeholder that clutters the log.
            setTurns((ts) => ts.filter((t) => t.id !== turnId));
            controller.abort();
            break;
          }
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
          const d = evt.data as { timings?: Record<string, number> };
          patchTurn(turnId, {
            streamingDone: true,
            llmTotalMs: d.timings?.totalMs,
          });
        } else if (evt.event === "audio") {
          const d = evt.data as {
            base64: string;
            format: string;
            ms: number;
            index?: number;
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
          patchTurn(turnId, { error: d.message, streamingDone: true });
        } else if (evt.event === "done") {
          // Server finished — ensure the turn is marked done even if no
          // tokens arrived (e.g. empty-transcript path on the server).
          patchTurn(turnId, { streamingDone: true });
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        aborted = true;
      } else {
        patchTurn(turnId, { error: (e as Error).message, streamingDone: true });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
    return { gotAudio, aborted };
  }

  // -------------------- PTT mode --------------------

  async function startPtt() {
    if (recording || busy) return;
    // Barge-in for PTT: if the assistant is still talking back from the prior
    // turn, cut it off the moment the user taps the mic again.
    stopCurrentPlayback();
    setGlobalError(null);
    try {
      recorderRef.current = await startRecorder({
        onLevel: (rms01) => { levelRef.current = rms01; },
      });
      setRecording(true);
      startMeter();
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  }

  async function stopAndSendPtt() {
    if (!recording || !recorderRef.current) return;
    setRecording(false);
    setBusy(true);
    stopMeter();
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
      patchTurn(turnId, { error: (e as Error).message, streamingDone: true });
      setBusy(false);
      return;
    }

    if (durationMs < MIN_SEND_MS) {
      patchTurn(turnId, {
        error: `recording too short (<${MIN_SEND_MS}ms)`,
        streamingDone: true,
      });
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
      stopMeter();
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
          // If status === "processing": the user is speaking over us while
          // the assistant is still generating. We drop this utterance to
          // avoid concurrent turns; see handleSpeechEnd below for the gate.
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
        onLevel: (prob01) => { levelRef.current = prob01; },
      });
      setVadStatus("listening");
      startMeter();
    } catch (e) {
      setGlobalError((e as Error).message);
      setVadStatus("idle");
    }
  }

  async function handleSpeechEnd(wavBase64: string, durationMs: number) {
    // Gate: if we're already processing or actively playing, this speech-end
    // is either a VAD mis-segmentation of the current user utterance or
    // residual TTS echo. Drop it — don't start a second concurrent turn.
    const status = vadStatusRef.current;
    if (status === "processing" || status === "playing") {
      console.debug("[voice] dropped speech-end during", status);
      if (status === "playing") {
        // Nothing to do — barge-in would have happened via onSpeechStart.
      }
      return;
    }
    if (durationMs < MIN_SEND_MS) {
      if (status !== "idle") setVadStatus("listening");
      return;
    }
    setVadStatus("processing");
    const turnId = crypto.randomUUID();
    setTurns((t) => [...t, { id: turnId, audioUrls: [] }]);

    const { gotAudio, aborted } = await runTurn(turnId, wavBase64, true);

    if (modeRef.current !== "hands-free") return;
    if (aborted) return;
    if (!gotAudio) setVadStatus("listening");
  }

  function stopHandsFree() {
    stopCurrentPlayback();
    abortRef.current?.abort();
    vadRef.current?.destroy();
    vadRef.current = null;
    stopMeter();
    setVadStatus("idle");
  }

  // -------------------- Mode switching --------------------

  function switchMode(next: Mode) {
    if (next === mode) return;
    if (mode === "ptt") {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
      stopMeter();
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

  // -------------------- Derived render state --------------------

  const editorDisabled =
    busy || recording || (mode === "hands-free" && vadStatus !== "idle");

  const pttState: "idle" | "recording" | "busy" =
    recording ? "recording" : busy ? "busy" : "idle";
  const showMeter =
    recording || vadStatus === "listening" || vadStatus === "speaking";

  const hasTurns = turns.length > 0;
  const emptyHint =
    mode === "ptt"
      ? "Tap the mic, say something, then tap again to send. Everything runs locally — STT, model, and TTS."
      : "Tap start — silence ends your turn, the model replies out loud, and talking over it interrupts playback.";

  return (
    <div className="voice-panel chat-panel">
      <PipelineEditor
        config={config}
        onChange={onConfigChange}
        registry={registry}
        mode="voice"
        disabled={editorDisabled}
      />

      <details className="system-prompt voice-system-prompt">
        <summary>
          default prompt
          {config.voiceSystem !== DEFAULT_VOICE_PROMPT ? (
            <span className="muted"> (customised)</span>
          ) : (
            <span className="muted"> (shapes tone · handles STT errors)</span>
          )}
        </summary>
        <textarea
          value={config.voiceSystem}
          onChange={(e) => onConfigChange({ ...config, voiceSystem: e.target.value })}
          disabled={editorDisabled}
          rows={6}
          placeholder="how the model should behave in voice mode…"
        />
        {config.voiceSystem !== DEFAULT_VOICE_PROMPT && (
          <button
            className="mini-toggle"
            onClick={() => onConfigChange({ ...config, voiceSystem: DEFAULT_VOICE_PROMPT })}
            disabled={editorDisabled}
            style={{ marginTop: "0.35rem" }}
          >
            restore default
          </button>
        )}
      </details>

      <div className="voice-stage">
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
            hands-free
          </button>
        </div>

        <div className="voice-mic-wrap">
          {mode === "ptt" ? (
            <PttMicButton
              state={pttState}
              onStart={startPtt}
              onStop={stopAndSendPtt}
              onCancel={cancelPtt}
            />
          ) : (
            <HandsFreeMicButton
              vadStatus={vadStatus}
              onStart={startHandsFree}
              onStop={stopHandsFree}
            />
          )}
        </div>

        <div className={`voice-meter ${showMeter ? "voice-meter-active" : ""}`}>
          <div className="voice-meter-bars" ref={meterRef}>
            {Array.from({ length: METER_BARS }, (_, i) => (
              <span key={i} className="voice-meter-bar" />
            ))}
          </div>
          <span className="voice-meter-label">
            {showMeter
              ? mode === "ptt" ? "recording" : vadPillLabel(vadStatus)
              : mode === "hands-free" && vadStatus !== "idle"
                ? vadPillLabel(vadStatus)
                : ""}
          </span>
        </div>

        <div className="voice-toolbar">
          <button
            className={showMetrics ? "mini-toggle mini-toggle-on" : "mini-toggle"}
            onClick={() => setShowMetrics((v) => !v)}
            title="toggle per-turn latency numbers"
          >
            metrics
          </button>
          <button
            onClick={reset}
            disabled={busy || recording || vadStatus !== "idle" || !hasTurns}
          >
            reset
          </button>
        </div>
      </div>

      {globalError && <div className="chat-error">error: {globalError}</div>}

      <div className="chat-log voice-log" ref={logRef}>
        {!hasTurns && (
          <div className="voice-empty">
            <div className="voice-empty-title">
              a full voice loop, all on your machine
            </div>
            <div className="voice-empty-body">{emptyHint}</div>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} showMetrics={showMetrics} />
        ))}
      </div>
    </div>
  );
}

// -------------------- Subcomponents --------------------

function PttMicButton({
  state,
  onStart,
  onStop,
  onCancel,
}: {
  state: "idle" | "recording" | "busy";
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  if (state === "recording") {
    return (
      <div className="mic-cluster">
        <button className="mic-btn mic-btn-recording" onClick={onStop} title="send">
          <span className="mic-icon">■</span>
          <span className="mic-label">send</span>
        </button>
        <button className="mic-aux" onClick={onCancel}>cancel</button>
      </div>
    );
  }
  if (state === "busy") {
    return (
      <div className="mic-cluster">
        <button className="mic-btn mic-btn-busy" disabled>
          <span className="mic-icon">…</span>
          <span className="mic-label">thinking</span>
        </button>
        <button className="mic-aux" onClick={onCancel}>abort</button>
      </div>
    );
  }
  return (
    <div className="mic-cluster">
      <button className="mic-btn mic-btn-idle" onClick={onStart} title="start recording">
        <span className="mic-icon">●</span>
        <span className="mic-label">tap to talk</span>
      </button>
    </div>
  );
}

function HandsFreeMicButton({
  vadStatus,
  onStart,
  onStop,
}: {
  vadStatus: VadStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  if (vadStatus === "idle") {
    return (
      <div className="mic-cluster">
        <button className="mic-btn mic-btn-idle" onClick={onStart}>
          <span className="mic-icon">◉</span>
          <span className="mic-label">start listening</span>
        </button>
      </div>
    );
  }
  if (vadStatus === "loading") {
    return (
      <div className="mic-cluster">
        <button className="mic-btn mic-btn-busy" disabled>
          <span className="mic-icon">◐</span>
          <span className="mic-label">loading vad</span>
        </button>
      </div>
    );
  }
  return (
    <div className="mic-cluster">
      <button
        className={`mic-btn mic-btn-${vadStatus}`}
        onClick={onStop}
        title="stop listening"
      >
        <span className="mic-icon">■</span>
        <span className="mic-label">{vadPillLabel(vadStatus)}</span>
      </button>
    </div>
  );
}

function TurnView({ turn, showMetrics }: { turn: Turn; showMetrics: boolean }) {
  const waitingForTranscript = turn.transcript === undefined && !turn.error;
  const waitingForLlm =
    turn.transcript !== undefined &&
    turn.llmText === undefined &&
    !turn.streamingDone &&
    !turn.error;
  const streaming =
    turn.llmText !== undefined && !turn.streamingDone && !turn.error;

  return (
    <div className="turn voice-turn">
      <div className="chat-msg chat-msg-user">
        <div className="chat-role">you</div>
        <div className="chat-content">
          {waitingForTranscript ? (
            <span className="pending">
              <span className="pending-dots"><span /><span /><span /></span>
              <span className="muted"> transcribing</span>
            </span>
          ) : turn.transcript ? (
            turn.transcript
          ) : (
            <span className="muted">(no speech detected)</span>
          )}
        </div>
      </div>

      {(turn.llmText !== undefined || waitingForLlm || turn.error) && (
        <div className={`chat-msg chat-msg-assistant${streaming ? " chat-msg-streaming" : ""}`}>
          <div className="chat-role">assistant</div>
          <div className="chat-content">
            {waitingForLlm ? (
              <span className="pending">
                <span className="pending-dots"><span /><span /><span /></span>
                <span className="muted"> thinking</span>
              </span>
            ) : turn.llmText !== undefined ? (
              <>
                {turn.llmText}
                {streaming && <span className="cursor">▊</span>}
              </>
            ) : null}
          </div>
        </div>
      )}

      {showMetrics && (
        <div className="turn-metrics">
          {turn.sttMs != null && <span>stt {turn.sttMs.toFixed(0)}ms</span>}
          {turn.llmTtftMs != null && <span>ttft {turn.llmTtftMs.toFixed(0)}ms</span>}
          {turn.llmTotalMs != null && <span>llm {turn.llmTotalMs.toFixed(0)}ms</span>}
          {turn.firstAudioMs != null && (
            <span>audio₁ {turn.firstAudioMs.toFixed(0)}ms</span>
          )}
          {turn.audioUrls.length > 1 && (
            <span>{turn.audioUrls.length} segments</span>
          )}
        </div>
      )}

      {turn.error && <div className="chat-error">turn error: {turn.error}</div>}
    </div>
  );
}
