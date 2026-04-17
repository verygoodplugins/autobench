import { useEffect, useState } from "react";
import { ChatPanel } from "./playground/ChatPanel";
import { VoicePanel } from "./playground/VoicePanel";

type Registry = { vad: string[]; stt: string[]; llm: string[]; tts: string[] };

type Mode = "chat" | "voice";

export function Playground() {
  const [mode, setMode] = useState<Mode>("chat");
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/plugins")
      .then((r) => r.json())
      .then(setRegistry)
      .catch((e) => setError(String(e)));
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
      {mode === "chat" && <ChatPanel registry={registry} />}
      {mode === "voice" && <VoicePanel registry={registry} />}
    </div>
  );
}
