import { useEffect, useState } from "react";
import type { LlmConfig, PipelineConfig } from "../../lib/pipeline";
import { CLAUDE_MODELS, MODEL_DEFAULTS, numOrUndefined } from "../../lib/pipeline";

type Registry = { vad: string[]; stt: string[]; llm: string[]; tts: string[] };

type Props = {
  config: PipelineConfig;
  onChange: (next: PipelineConfig) => void;
  registry: Registry | null;
  mode: "chat" | "voice";
  disabled?: boolean;
};

export function PipelineEditor({ config, onChange, registry, mode, disabled }: Props) {
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/ollama/models")
      .then((r) => r.json())
      .then((d: { models?: string[]; error?: string }) => {
        if (d.error) setModelsError(d.error);
        else setOllamaModels(d.models ?? []);
      })
      .catch((e) => setModelsError(String(e)));
  }, []);

  function patchLlm(patch: Partial<LlmConfig>) {
    onChange({ ...config, llm: { ...config.llm, ...patch } });
  }

  function onLlmNameChange(name: string) {
    const nextModel = MODEL_DEFAULTS[name] ?? "";
    patchLlm({ name, model: nextModel });
  }

  const llmOptions = registry?.llm ?? ["ollama", "claude"];
  const sttOptions = (registry?.stt ?? ["parakeet", "whisper-server"]).filter(
    (n) => n === "parakeet" || n === "whisper-server"
  );
  const ttsOptions = (registry?.tts ?? ["kokoro", "macos-say", "piper"]).filter(
    (n) => n === "kokoro" || n === "macos-say" || n === "piper"
  );

  const modelCatalog =
    config.llm.name === "ollama" ? ollamaModels : config.llm.name === "claude" ? CLAUDE_MODELS : null;
  const showModelDropdown = !!modelCatalog;
  const modelInCatalog = showModelDropdown && modelCatalog!.includes(config.llm.model);

  return (
    <div className="pipeline-editor">
      <div className="row">
        {mode === "voice" && (
          <label>
            stt&nbsp;
            <select
              value={config.stt.name}
              onChange={(e) => onChange({ ...config, stt: { name: e.target.value } })}
              disabled={disabled}
            >
              {sttOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <label>
          llm&nbsp;
          <select
            value={config.llm.name}
            onChange={(e) => onLlmNameChange(e.target.value)}
            disabled={disabled}
          >
            {llmOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          model&nbsp;
          {showModelDropdown ? (
            <select
              value={modelInCatalog ? config.llm.model : "__custom"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom") return;
                patchLlm({ model: v });
              }}
              disabled={disabled}
              style={{ minWidth: "16rem" }}
            >
              {modelCatalog!.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="__custom">custom…</option>
            </select>
          ) : null}
          {(!showModelDropdown || !modelInCatalog) && (
            <input
              value={config.llm.model}
              onChange={(e) => patchLlm({ model: e.target.value })}
              disabled={disabled}
              placeholder={config.llm.name === "ollama" ? "ollama model tag" : "model id"}
              style={{ width: "14rem", marginLeft: showModelDropdown ? "0.4rem" : 0 }}
            />
          )}
        </label>
        <label>
          temp&nbsp;
          <input
            value={config.llm.temperature ?? ""}
            onChange={(e) => patchLlm({ temperature: numOrUndefined(e.target.value) })}
            disabled={disabled}
            style={{ width: "3.5rem" }}
          />
        </label>
        <label>
          max tokens&nbsp;
          <input
            value={config.llm.maxTokens ?? ""}
            onChange={(e) => patchLlm({ maxTokens: numOrUndefined(e.target.value) })}
            disabled={disabled}
            style={{ width: "4.5rem" }}
          />
        </label>

        {mode === "voice" && (
          <>
            <label>
              <input
                type="checkbox"
                checked={config.tts.enabled}
                onChange={(e) => onChange({ ...config, tts: { ...config.tts, enabled: e.target.checked } })}
                disabled={disabled}
              />
              &nbsp;tts
            </label>
            <select
              value={config.tts.name}
              onChange={(e) => onChange({ ...config, tts: { ...config.tts, name: e.target.value } })}
              disabled={disabled || !config.tts.enabled}
            >
              {ttsOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        )}
      </div>

      <details className="pipeline-advanced">
        <summary>advanced · {summarizeAdvanced(config.llm)}</summary>
        <div className="row" style={{ marginTop: "0.4rem" }}>
          {config.llm.name === "ollama" && (
            <>
              <label>
                num_ctx&nbsp;
                <input
                  value={config.llm.numCtx ?? ""}
                  onChange={(e) => patchLlm({ numCtx: numOrUndefined(e.target.value) })}
                  disabled={disabled}
                  style={{ width: "5rem" }}
                />
              </label>
              <label>
                top_p&nbsp;
                <input
                  value={config.llm.topP ?? ""}
                  onChange={(e) => patchLlm({ topP: numOrUndefined(e.target.value) })}
                  disabled={disabled}
                  placeholder="0.9"
                  style={{ width: "4rem" }}
                />
              </label>
              <label>
                top_k&nbsp;
                <input
                  value={config.llm.topK ?? ""}
                  onChange={(e) => patchLlm({ topK: numOrUndefined(e.target.value) })}
                  disabled={disabled}
                  placeholder="40"
                  style={{ width: "4rem" }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.llm.think ?? false}
                  onChange={(e) => patchLlm({ think: e.target.checked })}
                  disabled={disabled}
                />
                &nbsp;think
              </label>
            </>
          )}
          {config.llm.name === "claude" && (
            <label>
              <input
                type="checkbox"
                checked={config.llm.thinking ?? false}
                onChange={(e) => patchLlm({ thinking: e.target.checked })}
                disabled={disabled}
              />
              &nbsp;thinking (adaptive)
            </label>
          )}
        </div>
      </details>

      {modelsError && config.llm.name === "ollama" && (
        <div className="muted" style={{ fontSize: "0.75rem" }}>
          couldn't reach /ollama/models: {modelsError} — falling back to free-text input
        </div>
      )}
    </div>
  );
}

function summarizeAdvanced(cfg: LlmConfig): string {
  const bits: string[] = [];
  if (cfg.name === "ollama") {
    if (cfg.numCtx) bits.push(`ctx=${cfg.numCtx}`);
    if (cfg.topP !== undefined) bits.push(`top_p=${cfg.topP}`);
    if (cfg.topK !== undefined) bits.push(`top_k=${cfg.topK}`);
    if (cfg.think) bits.push("think");
  } else if (cfg.name === "claude") {
    if (cfg.thinking) bits.push("thinking");
  }
  return bits.length ? bits.join(" · ") : "defaults";
}
