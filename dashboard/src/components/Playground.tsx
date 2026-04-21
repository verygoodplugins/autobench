import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./playground/ChatPanel";
import { VoicePanel } from "./playground/VoicePanel";
import { DEFAULT_PIPELINE, type PipelineConfig } from "../lib/pipeline";

type Registry = { vad: string[]; stt: string[]; llm: string[]; tts: string[] };

type Mode = "chat" | "voice";

export function Playground() {
  const [mode, setMode] = useState<Mode>("chat");
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineConfig>(DEFAULT_PIPELINE);

  useEffect(() => {
    fetch("/plugins")
      .then((r) => r.json())
      .then(setRegistry)
      .catch((e) => setError(String(e)));
  }, []);

  // Pick the best TTS available on this server (kokoro > piper > macos-say).
  // Only runs once and only if the user hasn't already changed the default.
  const appliedDefaultsRef = useRef<boolean>(false);
  useEffect(() => {
    if (appliedDefaultsRef.current) return;
    appliedDefaultsRef.current = true;
    fetch("/playground/defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { tts?: { name?: string } } | null) => {
        const next = data?.tts?.name;
        if (!next) return;
        setPipeline((prev) =>
          prev.tts.name === DEFAULT_PIPELINE.tts.name && next !== prev.tts.name
            ? { ...prev, tts: { ...prev.tts, name: next } }
            : prev
        );
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="playground">
      <div className="row subtabs">
        <button
          className={mode === "chat" ? "tab-active" : ""}
          onClick={() => setMode("chat")}
        >
          chat
        </button>
        <button
          className={mode === "voice" ? "tab-active" : ""}
          onClick={() => setMode("voice")}
        >
          voice
        </button>
        {error && <span className="muted">registry: {error}</span>}
      </div>
      {mode === "chat" && (
        <ChatPanel config={pipeline} onConfigChange={setPipeline} registry={registry} />
      )}
      {mode === "voice" && (
        <VoicePanel config={pipeline} onConfigChange={setPipeline} registry={registry} />
      )}
    </div>
  );
}
