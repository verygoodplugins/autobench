# autobench

A plugin-based harness for building, benchmarking, and A/B-ing local voice and chat pipelines.

```text
[ mic ] → VAD → STT → LLM → TTS → [ speaker ]
                       ^
              (text-to-text stops here)
```

Part of the Auto- family: [AutoMem](https://github.com/verygoodplugins/automem), [AutoJack](https://autojack.ai), AutoHub. Brought to you by [Jack Arturo](https://x.com/jjack_arturo) & [Very Good Plugins](https://verygoodplugins.com).

The thing being benchmarked is the **configuration**, not any single component. Pick candidates for each slot, pick prompts, and autobench tells you which combination is fastest, most accurate, and most memory-efficient on _your_ machine — then lets you feel it for yourself in a live playground.

---

## Highlights

- **Plugin registry** for four slots (VAD / STT / LLM / TTS). Add a new engine in ~50–150 lines.
- **Matrix runner** sweeps `pipeline × prompt × repetitions`, streams JSONL, emits a P50/P95/P99 markdown summary.
- **Interactive playground** — chat and voice subtabs in the dashboard. Voice mode streams tokens while it transcribes, synthesizes TTS in sentence-sized segments so you hear audio within ~1s of the first token, and supports push-to-talk or hands-free VAD with barge-in.
- **First-class Apple Silicon** — samples `memory_pressure` and Ollama RSS per run; tuned for M-series Metal kernel quirks.

## Three modes

| mode             | slots used            | typical use                            |
| ---------------- | --------------------- | -------------------------------------- |
| `text-to-text`   | LLM                   | compare local models at fixed prompts  |
| `voice-to-text`  | VAD + STT + LLM       | transcription + reply pipeline         |
| `voice-to-voice` | VAD + STT + LLM + TTS | full turn latency and first-audio time |

## Quick start

Requires Node 20+. [Ollama](https://ollama.ai) running locally is enough for text-to-text; voice modes need an STT server (whisper.cpp or parakeet-mlx) and a TTS engine (kokoro is bundled, piper needs a binary, macos-say is free on darwin).

```bash
git clone https://github.com/verygoodplugins/autobench
cd autobench
npm install
cp .env.example .env          # edit to taste
npm run build

# Check which plugins loaded
node bin/autobench.js list

# Smoke-test the runner (needs Ollama + one model pulled)
node bin/autobench.js run configs/smoke.yaml

# Launch server + dashboard together
npm run dev:full              # backend :8782, dashboard :5173
# ...or the two halves separately:
npm run serve
npm run dashboard:dev
```

Each run appends to `runs/<name>.jsonl` and emits `<name>.summary.md`. The dashboard (`http://localhost:5173`) reads both — use the `runs` tab for history and the `playground` tab for live interaction.

## The playground

Open `http://localhost:5173`, click `playground`, then pick `chat` or `voice`:

### chat subtab

Streaming LLM turns with live TTFT, tokens/sec, and token-count readouts. Use the pipeline editor to flip between Ollama models or Claude. `⌘↩` to send.

### voice subtab

A real-time voice loop, all on-device:

- **push-to-talk**: tap the mic, speak, tap again to send. Live mic-level meter while recording.
- **hands-free**: Silero VAD detects speech start/end and auto-submits on silence. The VAD also handles _barge-in_ — talking during the assistant's TTS aborts playback and captures your new utterance.
- **Streaming TTS**: the server buffers the LLM token stream into sentence-sized segments and synthesizes them in parallel, so the first spoken audio leaves your speaker well before the full response has generated.
- **Smart defaults**: on first load, the voice subtab auto-selects the best TTS available on your server (kokoro → piper → macos-say). A `default prompt` section ships pre-populated with a system message tuned for STT errors and conversational replies — edit freely, hit `restore default` to get it back.

Toggle the `metrics` pill in the stage to surface per-turn STT / TTFT / LLM / first-audio timings without cluttering the demo.

---

## Adding and comparing models

The workflow is the same whether you want to A/B-compare two Ollama models, swap in a Claude model, or try a different quant. Do it interactively in the playground first; then capture it as a benchmark matrix so the numbers are reproducible.

### 1 · pull and try a new Ollama model

```bash
ollama pull qwen3.6:35b-a3b
```

Open the playground, pick `ollama` as the LLM slot, and the `model` dropdown will list everything `ollama list` returns (live-queried from `/api/tags`). Type a prompt in `chat` or speak one in `voice`. You'll see TTFT, tokens/sec, first-audio latency, and the full reply in-situ.

### 2 · add a Claude model

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or put it in .env
```

The `claude` LLM plugin is always registered; the model dropdown includes Opus 4.7, Sonnet 4.6, and Haiku 4.5. Free to extend `CLAUDE_MODELS` in `dashboard/src/lib/pipeline.ts` for newer releases.

### 3 · capture a head-to-head as a matrix

Once you know what you want to compare, pin it as a `.yaml` in `configs/`:

```yaml
mode: text-to-text
runs: 3                        # repetitions per (pipeline × prompt), P50/P95 need ≥3
prompts:
  - id: reasoning
    text: "A train leaves Boston at 7:00 AM going 60 mph..."
  - id: creative
    text: "Write a three-sentence noir opening about a detective who only drinks yerba mate."

pipelines:
  - name: local-fast
    llm:
      name: ollama
      config: { model: qwen3.6:35b-a3b, numCtx: 16384, numPredict: 512, think: false }

  - name: local-big
    llm:
      name: ollama
      config: { model: llama3.3:70b,    numCtx:  8192, numPredict: 512, think: false }

  - name: reasoning
    llm:
      name: ollama
      config: { model: deepseek-r1:70b, numCtx: 16384, numPredict: 2048, think: true }

  - name: api-baseline
    llm:
      name: claude
      config: { model: claude-haiku-4-5, maxTokens: 512 }
```

Run it:

```bash
node bin/autobench.js run configs/my-shootout.yaml
```

### 4 · read the numbers

The runner prints a live-updating JSONL stream and, at the end, a markdown summary grouped by pipeline:

```markdown
# autobench summary
_12 runs across 4 pipelines_

| pipeline                                | n | TTFT p50  | TTFT p95  | TPS p50     | total p50 |
|-----------------------------------------|--:|----------:|----------:|------------:|----------:|
| - → - → ollama(qwen3.6:35b-a3b) → -     | 9 |   197.6ms |  2614.2ms | 49.8 tok/s  |  3801.8ms |
| - → - → ollama(llama3.3:70b) → -        | 9 |   191.3ms |  5725.0ms |  7.1 tok/s  | 20704.4ms |
| - → - → ollama(deepseek-r1:70b) → -     | 9 | 34764.3ms | 99101.4ms |  6.8 tok/s  | 54119.8ms |
| - → - → claude(claude-haiku-4-5) → -    | 9 |   792.0ms |  1204.0ms | 89.3 tok/s  |  1180.0ms |
```

The dashboard `runs` tab renders the same view plus interactive latency charts from `runs/*.jsonl`.

> **The first run of a fresh model is slow** (cold model load). Report P50/P95 over `runs: 3+` so the first run doesn't dominate.

### 5 · voice and voice-to-voice comparisons

Same pattern, more slots. Example `configs/voice-to-voice.yaml`:

```yaml
mode: voice-to-voice
runs: 2
prompts:
  - id: greeting
    audioPath: fixtures/greeting.wav
    reference: "Hello, how are you doing today?"
pipelines:
  - name: kokoro-fast
    stt: { name: whisper-server, config: { serverUrl: http://localhost:8178 } }
    llm: { name: ollama,         config: { model: qwen2.5-coder:32b, numPredict: 256 } }
    tts: { name: kokoro,         config: { voice: af_heart } }
  - name: piper-fast
    stt: { name: parakeet,       config: { serverUrl: http://localhost:8179 } }
    llm: { name: ollama,         config: { model: qwen2.5-coder:32b, numPredict: 256 } }
    tts: { name: piper,          config: { speaker: 0 } }
```

Voice modes need reference audio in `fixtures/` (16 kHz mono WAV) and a `reference` string for WER computation.

---

## Built-in plugins

| slot | plugin           | notes                                                                  |
| ---- | ---------------- | ---------------------------------------------------------------------- |
| VAD  | `sox-silence`    | energy threshold baseline                                              |
| VAD  | `silero`         | Silero v5 ONNX, frame-level speech probability                         |
| STT  | `whisper-server` | whisper.cpp `/inference` endpoint; supports streaming partials         |
| STT  | `parakeet`       | parakeet-mlx server; fast on Apple Silicon                             |
| LLM  | `ollama`         | any model `ollama serve` exposes; `think`, `numCtx`, `numPredict`, etc |
| LLM  | `claude`         | Anthropic API; Opus / Sonnet / Haiku; streaming + extended thinking    |
| TTS  | `kokoro`         | local neural ONNX (~150 MB); preferred default when it loads cleanly   |
| TTS  | `piper`          | rhasspy/piper; fast, needs a binary + voice `.onnx`                    |
| TTS  | `macos-say`      | built-in macOS `say`; always available on darwin                       |

## Writing a new plugin

1. Pick a slot (`vad | stt | llm | tts`) and implement the corresponding interface in `src/core/types.ts`.
2. Register at module load: `registry.register(kind, name, async (config) => new YourPlugin())`.
3. Add `await import("../plugins/<slot>/<name>.js")` to `loadBuiltins()` in `src/core/registry.ts`.
4. Use it in a matrix via `{ name: "<your-name>", config: {...} }`, or expose it in the playground by adding the safe config keys to `CONFIG_ALLOWLIST` in `src/playground.ts`.

Plugins live for the process lifetime; expensive init (ONNX model load, subprocess spawn, HTTP pool) should happen on first call and be memoized on `this`. The runner caches plugin instances keyed by `${slot}:${name}:${stableStringify(config)}`, so identical configs reuse a warm instance across every pipeline × prompt × repetition. Do **not** implement `teardown()` for model-holding plugins — the cache handles reuse.

Reference: `src/plugins/llm/ollama.ts` (streaming), `src/plugins/stt/parakeet.ts` (HTTP form-upload), `src/plugins/tts/kokoro.ts` (ONNX-backed local model).

## Environment variables

See `.env.example` for defaults. Commonly overridden:

| var                         | what it does                                                                   |
| --------------------------- | ------------------------------------------------------------------------------ |
| `AUTOBENCH_PORT`            | server port (default `8782`)                                                   |
| `OLLAMA_BASE_URL`           | `http://localhost:11434` by default                                            |
| `WHISPER_SERVER_URL`        | `http://localhost:8178` by default                                             |
| `PARAKEET_SERVER_URL`       | `http://localhost:8179` by default (avoids whisper's :8178)                    |
| `ANTHROPIC_API_KEY`         | required for the `claude` LLM plugin                                           |
| `PIPER_MODEL`               | path to a piper voice `.onnx`; required to enable piper in the playground      |
| `PIPER_BINARY`              | path to `piper` executable (default `piper` on PATH)                           |
| `PIPER_MODEL_CONFIG`        | optional path to the matching `.onnx.json`                                     |
| `AUTOBENCH_DISABLE_KOKORO`  | set to `1` to skip kokoro in the playground's default-TTS preference order     |
| `GGML_METAL_TENSOR_DISABLE` | set to `1` on M-series before `ollama serve` to avoid tensor-kernel stalls     |
| `GGML_METAL_BF16_DISABLE`   | set to `1` on M-series before `ollama serve` to avoid BF16-related degradation |

## Hardware notes

First-class support for Apple Silicon (M1–M5). On macOS, autobench samples `memory_pressure` and Ollama RSS per run. On M5 Max (128 GB), set `GGML_METAL_TENSOR_DISABLE=1` and `GGML_METAL_BF16_DISABLE=1` before starting `ollama serve` to avoid long-benchmark Metal stalls.

## Design

- **TypeScript strict** + ES modules, Node 20+
- **Runner** is plain async; no framework lock-in
- **Dashboard** is Vite + React + Recharts, proxies to the Node server
- **JSONL** is the source of truth; the dashboard is a read-only view of it
- **Server-sent events** power live streaming in both runner progress and playground turns

## Contributing

Issues and PRs welcome. If you're adding a plugin, a small matrix under `configs/` that exercises it is a nice touch. Benchmark numbers from non-Apple hardware especially welcome.

## License

MIT © Very Good Plugins 🧡
