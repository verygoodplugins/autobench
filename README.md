# autobench

Benchmark VAD, STT, LLM, and TTS combinations to find the optimal voice/chat pipeline for your hardware.

Part of the Auto- family: [AutoMem](https://github.com/verygoodplugins/automem), [AutoJack](https://autojack.ai), AutoHub. Brought to you by [Jack Arturo](https://x.com/jjack_arturo) & [Very Good Plugins](https://verygoodplugins.com).

## What it is

A plugin-based harness for sweeping configurations across four slots:

```
[ mic ] → VAD → STT → LLM → TTS → [ speaker ]
                        ^
               (text-to-text stops here)
```

The thing being benchmarked is the **configuration**, not any single component. Pick a slot, pick candidates, pick prompts, and autobench tells you which combination is fastest, most accurate, or most memory-efficient on _your_ machine.

## Three modes

| mode             | slots used            | typical use                           |
| ---------------- | --------------------- | ------------------------------------- |
| `text-to-text`   | LLM                   | compare local models at fixed prompts |
| `voice-to-text`  | VAD + STT + LLM       | transcription + reply pipeline        |
| `voice-to-voice` | VAD + STT + LLM + TTS | full turn latency, first-audio time   |

## Quick start

```bash
npm install
npm run build

# List built-in plugins
node bin/autobench.js list

# Run a text-to-text matrix (no voice hardware needed)
node bin/autobench.js run configs/m5-max.yaml

# Serve the React dashboard + interactive playground (server + UI in one command)
npm run dev:full                    # backend on :8782, frontend on :5173

# Or run the two halves separately:
npm run serve                       # backend on :8782
npm run dashboard:dev               # frontend on :5173
```

Each run appends to `runs/<timestamp>.jsonl` and emits `<timestamp>.summary.md`.

## Built-in plugins

| slot | plugin           | notes                               |
| ---- | ---------------- | ----------------------------------- |
| VAD  | `sox-silence`    | energy threshold baseline           |
| STT  | `whisper-server` | whisper.cpp /inference endpoint     |
| LLM  | `ollama`         | any Ollama model via `config.model` |
| TTS  | `kokoro`         | ONNX local neural TTS (~150 MB)     |
| TTS  | `macos-say`      | built-in macOS `say`                |

Adding a plugin is ~50–150 lines — implement the slot interface in `src/core/types.ts` and `registry.register(...)`. See `src/plugins/llm/ollama.ts` for the pattern.

## Metrics

Per run autobench records:

- **VAD**: endpoint-detection latency
- **STT**: transcription time, RTF (real-time factor), WER (when `reference` is set)
- **LLM**: TTFT, TPS, completion tokens, load time
- **TTS**: time-to-first-audio, RTF
- **End-to-end**: total turn time, memory resident, memory pressure

Results are aggregated as P50/P95/P99 per pipeline in the dashboard and summary markdown.

## Matrix config

```yaml
mode: text-to-text
runs: 3
prompts:
  - id: short
    text: "List three CLI tools every JS dev should know."
pipelines:
  - llm:
      name: ollama
      config: { model: qwen2.5-coder:32b, numPredict: 512 }
  - llm:
      name: ollama
      config: { model: llama3.3:70b, numPredict: 512 }
```

## Hardware

First-class support for Apple Silicon (M1–M5). On macOS, autobench samples `memory_pressure` and Ollama RSS per run. For M5 Max, set:

```bash
export GGML_METAL_TENSOR_DISABLE=1
export GGML_METAL_BF16_DISABLE=1
```

before starting `ollama serve` to avoid Metal tensor kernel stalls on long-running benchmarks.

## Design

- **TypeScript**, strict, ES modules
- **Node 20+**
- **No framework lock-in** on the runner — plugins are plain async functions
- **Dashboard** is Vite + React + Recharts, proxies to the Node server
- **JSONL** is the source of truth; the dashboard is a read-only view

## License

MIT © Very Good Plugins 🧡
