# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@verygoodplugins/autobench` — a plugin-based benchmark harness for voice/chat pipelines. Sweeps configurations across four slots (VAD → STT → LLM → TTS) and reports TTFT, tokens/sec, first-audio latency, and end-to-end turn time.

Extracted from `../uncensored-voice-server` on 2026-04-17. The two repos are **fully decoupled** — autobench does not import from uncensored-voice-server and vice versa. Plugin implementations were copied, not shared.

Part of the Auto- family: AutoMem, AutoJack, AutoHub, AutoBench.

**This is an ES module, strict TypeScript project (Node 20+).** Use `import`/`export`, not `require`.

## Three run modes

| mode | slots used | input |
| --- | --- | --- |
| `text-to-text` | LLM | prompt text |
| `voice-to-text` | STT + LLM (+ VAD) | audio file |
| `voice-to-voice` | STT + LLM + TTS (+ VAD) | audio file |

Mode is declared in the matrix YAML. The runner gates which slots are required.

## Commands

```bash
# Build TS -> dist/
npm run build
npm run typecheck                  # no emit

# List all registered plugins (sanity check the registry loaded)
node bin/autobench.js list

# Run a matrix, emit runs/<name>.jsonl + runs/<name>.summary.md
node bin/autobench.js run configs/smoke.yaml --out runs/smoke.jsonl
node bin/autobench.js run configs/m5-max.yaml
node bin/autobench.js run configs/voice-to-voice.yaml

# Serve HTTP + SSE on :8782 for the dashboard
node bin/autobench.js serve
# or: npm run serve

# Dashboard (Vite + React) on :5173, proxies API to :8782
npm run dashboard:dev
npm run dashboard:build
```

## Architecture

```
src/
├── core/
│   ├── types.ts       # PluginBase, VadPlugin, SttPlugin, LlmPlugin, TtsPlugin, RunRecord
│   ├── registry.ts    # Global `registry` singleton + loadBuiltins()
│   ├── runner.ts      # loadMatrix, runMatrix (plugin cache lives here)
│   ├── metrics.ts     # percentile, summaryStats, wer, rtf, Stopwatch
│   ├── jsonl.ts       # JsonlWriter, readRuns
│   ├── hardware.ts    # sampleHardware() — darwin memory_pressure + RSS
│   └── report.ts      # toMarkdownSummary(records) — groups by pipeline
├── plugins/
│   ├── vad/{sox-silence,silero}.ts
│   ├── stt/{whisper-server,parakeet}.ts
│   ├── llm/{ollama,claude}.ts
│   └── tts/{kokoro,macos-say,piper}.ts
├── cli/{run,serve,list}.ts
├── server.ts          # Express + SSE
└── index.ts           # public exports

bin/autobench.js       # dispatcher to dist/cli/*
configs/*.yaml         # matrix definitions
dashboard/             # Vite + React + Recharts, proxies to server
runs/                  # JSONL output (gitignored except .gitkeep)
fixtures/              # reference audio + transcripts (gitignored placeholder)
```

## Key Data Flow

1. `bin/autobench.js run <matrix.yaml>` → `src/cli/run.ts`.
2. `loadMatrix()` parses YAML, validates mode + prompts + pipelines.
3. `runMatrix()` creates a `PluginCache`, iterates `pipeline × prompt × runs`, calls `runOnce()` for each.
4. `runOnce()` chains STT → LLM → TTS as required by mode, assembles a `RunRecord`.
5. `JsonlWriter` appends one JSON line per run to `runs/<name>.jsonl`.
6. After the stream ends, `toMarkdownSummary()` groups by pipeline and emits P50/P95/P99 as `<name>.summary.md`.
7. The dashboard reads `/runs` (list), `/runs/:file` (records), `/plugins` (registry) from the server.

## Plugin System

### Adding a plugin (~50–150 LOC)

1. Pick a slot (`vad | stt | llm | tts`) and implement the corresponding interface from `src/core/types.ts`.
2. `registry.register(kind, name, async (config) => new YourPlugin())` at module load.
3. Add `await import("../plugins/<slot>/<name>.js")` to `loadBuiltins()` in `src/core/registry.ts`.
4. Users wire it into a matrix via `{ name: "<your-name>", config: {...} }`.

Plugins live for the process lifetime. Expensive init (ONNX model load, HTTP connections) should happen on first `synthesize`/`transcribe`/`generate` call and be memoized on `this`. Do **not** implement `teardown()` for model-holding plugins — the cache handles reuse.

### Plugin cache (important)

`runMatrix()` in `src/core/runner.ts` caches plugin instances keyed by `${slot}:${name}:${stableStringify(config)}`. Two pipelines with identical config reuse the same instance. `teardownAll()` runs once in the outer `finally`, not per-run.

**This is why `Kokoro.teardown()` was removed.** Before the cache, Kokoro reloaded its 150MB ONNX model every run and `firstAudioMs` was dominated by load time.

### RunRecord schema

See `src/core/types.ts`. Key fields:

- `timings`: raw per-stage numbers, prefixed (`stt.*`, `llm.*`, `tts.*`).
- `metrics`: derived, comparable numbers (TTFT, TPS, firstAudioMs, totalMs).
- `pipeline`: frozen snapshot of the slot refs used, including config — the dashboard keys on this.
- `hardware.memoryResidentGb`: **currently hardcoded to sample `ollama` process**. See follow-ups.

## Known Gotchas

- **`sampleHardware("ollama")` is hardcoded** in `src/core/runner.ts:222`. LLM plugins should eventually declare their own process name. Fine for now since Ollama is the only LLM backend.
- **`GGML_METAL_TENSOR_DISABLE=1` + `GGML_METAL_BF16_DISABLE=1`** must be set on `ollama serve` before running long M5 Max benchmarks, or Metal tensor kernel stalls will tank TPS numbers after 500s. See `.env.example`.
- **`BodyInit` and `DOM` lib**: tsconfig includes `"DOM"` so `fetch` + `FormData` type with `BodyInit` without shims. Do not remove.
- **Dashboard `tsconfig.tsbuildinfo`** is gitignored because `tsc -b` writes it. Use `npx tsc --noEmit` to typecheck without emit.
- **First run is slow**. Ollama loads the model on first request (often 3–30s depending on size). Report P50/P95 over `runs: 3+` so the first run doesn't dominate.

## Matrix YAML Schema

```yaml
mode: text-to-text | voice-to-text | voice-to-voice
runs: 3                            # repetitions per (pipeline × prompt)
prompts:
  - id: short
    text: "prompt text here"       # required for *-to-text modes
    audioPath: fixtures/x.wav      # required for voice-* modes
    reference: "ground truth"      # optional, used for WER
pipelines:
  - name: fast                     # optional display name
    vad: { name: sox-silence, config: {...} }
    stt: { name: whisper-server, config: { serverUrl: "..." } }
    llm: { name: ollama, config: { model: "...", numCtx: 8192, numPredict: 512, think: false } }
    tts: { name: kokoro, config: { voice: af_heart } }
```

Unused slots can be omitted. The runner validates that required slots for the mode are present.

## Environment Variables

See `.env.example`. Key variables:

- `AUTOBENCH_PORT` — server port (default 8782)
- `OLLAMA_BASE_URL` — default `http://localhost:11434`
- `WHISPER_SERVER_URL` — default `http://localhost:8178`
- `ANTHROPIC_API_KEY` — required by `llm/claude`; falls through to `config.apiKey` if unset
- Parakeet STT defaults to `http://localhost:8179` — autohub's `parakeet-server` defaults to `:8178`, so start it with `PARAKEET_PORT=8179` (or override via the plugin's `serverUrl` config) to avoid collision with whisper-server
- `GGML_METAL_TENSOR_DISABLE=1`, `GGML_METAL_BF16_DISABLE=1` — set on ollama serve for M5 Max stability

## Recently Landed

- **Second plugin per slot** — merged as PR #1, `feat/second-plugin-per-slot` → `main` (2026-04-17). Commits `f1631cd` (claude LLM), `9114144` (silero VAD), `a165133` (parakeet STT), `28d1a20` (piper TTS + demo matrix + doc update), `855cd71` (piper flag note), `b529ca8` (merge polish: opts.stream===false in claude, onnxruntime-node pinned to 1.21.0, YAML comment fix). `claude` verified end-to-end (~800ms TTFT on haiku-4-5); silero/parakeet/piper dry-run only, pending fixtures/ audio + running services.

## Open Follow-ups

Tracked here until work resumes. **The next session will take on #1 below.**

1. **Interactive playground UI** — current dashboard only reviews finished runs. Add a live "playground" tab so a human can (a) chat with a pipeline in real time and feel its TTFT/tok-s streaming, and (b) hold a voice-to-voice conversation and feel end-of-turn detection + first-audio latency. Proves the plugins from the usability angle, not just the metrics angle.
   - Server-side: expose two new endpoints against existing plugins — `POST /playground/chat/stream` (SSE or WebSocket, streams LLM tokens) and `WS /playground/voice` (binary frames in: mic PCM16 → VAD → STT → LLM → TTS audio out). Reuse `registry.create()` + a short-lived playground session cache so the plugin-cache model still applies.
   - Dashboard-side: new Playground panel with pipeline picker (reads `/plugins`), chat transcript + token stream, voice mode with push-to-talk or VAD-gated mic, audio playback, live latency readouts (TTFT, first-audio, end-of-turn).
   - Keep the existing runs/benchmark view untouched — Playground is additive.
2. **Decouple hardware sampling from "ollama"** — make the process name a field on LLM plugin metadata so non-Ollama LLMs still report RSS. `src/core/runner.ts:213`.
3. **Wire SSE live-view in the dashboard** — server already emits `/run/stream` events; the UI currently polls `/runs` only. Naturally pairs with follow-up #1's SSE work.
4. **Add fixtures/ audio** — short WAV clips + reference transcripts so `voice-to-voice.yaml` runs without manual setup. Include a `fixtures/README.md` with provenance. Unblocks end-to-end verification of silero + parakeet + piper.
5. **WER computation** — `core/metrics.ts::wer` exists but `runOnce` doesn't invoke it. Compute when `prompt.reference` is set, write to `metrics.wer`.
6. **`npm run bench` smoke in CI** — a headless matrix + text-only LLM mock plugin for GitHub Actions.
7. **Publish**: `npm publish --access public` once CI is green.
8. **README badge row** (npm, CI, license) once 6–7 land.

## Testing the end-to-end path

```bash
# Requires Ollama running with at least one model pulled
node bin/autobench.js run configs/smoke.yaml --out runs/smoke.jsonl
cat runs/smoke.summary.md
```

First run will include cold model-load latency (~3s for 32B Q4). Re-running with `runs: 2+` confirms the plugin + Ollama cache keep subsequent runs fast (~100–200ms TTFT).

## License

MIT © Very Good Plugins
