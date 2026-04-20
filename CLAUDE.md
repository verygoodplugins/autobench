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
├── playground.ts      # /playground/chat/stream + /playground/voice/turn
├── core/plugin-cache.ts  # shared PluginCache (runner + playground)
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
- Parakeet STT defaults to `http://localhost:8179` — autohub's `parakeet-server` defaults to `:8178`, so start it with `PARAKEET_PORT=8179` (or override via the plugin's `serverUrl` config) to avoid collision with whisper-server. For the playground endpoint, set `PARAKEET_SERVER_URL` on the serve process (clients can't override it — see allowlist)
- `PIPER_MODEL`, `PIPER_BINARY`, `PIPER_MODEL_CONFIG` — required on the serve process to enable piper in the playground (filesystem paths are not client-configurable)
- `GGML_METAL_TENSOR_DISABLE=1`, `GGML_METAL_BF16_DISABLE=1` — set on ollama serve for M5 Max stability

## Playground (live pipeline UI)

Additive to the existing runs review. Two Express endpoints and a React tab:

- `POST /playground/chat/stream` — JSON `{ llm: { name, config }, messages, maxTokens?, temperature? }`. SSE events: `ready`, `token`, `done`, `error`. Token events carry a running `{ ttftMs, totalMs }`. The `done` event's metadata includes `promptTokens`, `completionTokens`, and `evalDurationMs` when the LLM reports them.
- `POST /playground/voice/turn` — JSON `{ stt, llm, tts?, audio (base64), audioFormat? }`. One-shot voice turn (PTT or hands-free). SSE events: `stt-start` → `transcript` → `token` (repeated, streaming) → `llm-done` → `audio` (repeated, one per TTS segment) → `done`. `audio` events carry `{ base64, format, ms, index, text }`; the server buffers LLM output into sentence-sized segments (hard punctuation + min chars, max-chars fallback) and synthesizes them via a concurrent TTS worker that runs alongside further token streaming, so the client starts playback well before the full response arrives. `tts-error` events surface per-segment synthesis failures without killing the turn.

**Config allowlist.** Clients can only override safe keys per slot/plugin (model, temperature, maxTokens, voice, etc.). Secrets and paths (`apiKey`, `baseUrl`, `serverUrl`, `binary`, `model` for piper) are stripped and re-injected server-side from environment variables. An unknown slot/plugin is refused with 400. See `src/playground.ts::CONFIG_ALLOWLIST`.

**Plugin cache.** `src/playground.ts` holds its own `PluginCache` (shared class with the runner via `core/plugin-cache.ts`) for the server process lifetime. Repeated chat turns against the same model hit a warm plugin instance and skip cold-start.

**Dashboard.** `dashboard/src/components/Playground.tsx` with `chat` and `voice` sub-tabs. Chat panel streams tokens with a blinking-cursor tail and live TTFT/tok-s/token-count readout. Voice panel has a `push-to-talk | hands-free (vad)` toggle. PTT uses an inline AudioWorklet @ 16 kHz, encodes PCM16 WAV client-side, POSTs, and queues returned audio segments for sequential playback. Hands-free mode runs `@ricky0123/vad-web` (Silero, self-hosted under `dashboard/public/vad/` via a `postinstall` script) which auto-detects speech start/end, drives the turn on silence, and supports barge-in (speech detected during TTS playback after a 300 ms arm-delay pauses playback and aborts the in-flight fetch). Both modes play audio via a programmatic queue of `Audio()` elements so the first segment from streaming TTS starts playing before later segments arrive. Reset clears history. `Stop` aborts in-flight fetches via AbortController.

**SSE client quirk.** `EventSource` can't POST, so `dashboard/src/lib/sse.ts` implements POST + ReadableStream + manual `event:`/`data:` parsing.

## Recently Landed

- **Hands-free VAD + streaming TTS segments** (2026-04-18). Voice playground now has a `push-to-talk | hands-free (vad)` toggle. Hands-free uses `@ricky0123/vad-web` (Silero, self-hosted at `dashboard/public/vad/`) to auto-detect speech start/end; speech-end auto-submits the turn; speech during TTS playback (after a 300 ms arm-delay) fires barge-in — pauses audio, aborts the fetch, captures the new utterance. Server-side, LLM output is buffered into sentence-sized segments and synthesized by a concurrent TTS worker, so each segment is emitted as its own `audio` SSE event. Client queues segments for sequential playback. First-audio latency is now (first-segment + first-TTS), not (full LLM + full TTS). Kokoro still hits onnxruntime-node's ONNX error (follow-up #1); macos-say and piper work end-to-end.

- **Interactive playground UI** — `feat/playground-ui` (2026-04-18). Chat streaming verified live in Chrome against ollama (qwen2.5-coder:32b, TTFT 342ms, 26.2 tok/s). Voice turn verified server-side via synthesized input (parakeet + ollama + macos-say, STT 75ms, LLM TTFT 109ms warm). Also fixed a real STT plugin bug: `form-data` npm package produced multipart parakeet-mlx's FastAPI parser rejected; switched both parakeet + whisper-server to native `FormData`+`Blob`, which also drops the `form-data` dep.

- **Second plugin per slot** — merged as PR #1, `feat/second-plugin-per-slot` → `main` (2026-04-17). Commits `f1631cd` (claude LLM), `9114144` (silero VAD), `a165133` (parakeet STT), `28d1a20` (piper TTS + demo matrix + doc update), `855cd71` (piper flag note), `b529ca8` (merge polish: opts.stream===false in claude, onnxruntime-node pinned to 1.21.0, YAML comment fix). `claude` verified end-to-end (~800ms TTFT on haiku-4-5); parakeet verified via playground turn (2026-04-18); silero/piper still dry-run only, pending fixtures/ audio.

## Open Follow-ups

1. **Kokoro ONNX runtime error** — `kokoro-js` throws `Preferred output locations must have the same size as output names` on `synthesize()` with onnxruntime-node 1.21.0 in this repo. Surfaced when wiring the voice playground; unrelated to playground code. Needs triage against kokoro-js versions or onnxruntime-node config. Workaround: use `macos-say` or `piper` in Playground and benchmark matrices for now.
2. **Streaming STT partials** — the hands-free loop still does one-shot STT at end-of-utterance. A streaming STT plugin interface (whisper-server supports partial transcripts; parakeet-mlx does not) would let the client show a live transcript as the user speaks. Not a latency win for the turn itself (LLM still blocks on final transcript), but a UX win.
4. **Decouple hardware sampling from "ollama"** — make the process name a field on LLM plugin metadata so non-Ollama LLMs still report RSS. `src/core/runner.ts:213`.
5. **Wire SSE live-view in the dashboard Runs tab** — server already emits `/run/stream` events; the UI currently polls `/runs` only. Would share the `lib/sse.ts` helper the playground already uses.
6. **Add fixtures/ audio** — short WAV clips + reference transcripts so `voice-to-voice.yaml` runs without manual setup. Include a `fixtures/README.md` with provenance. Unblocks end-to-end verification of silero + piper.
7. **WER computation** — `core/metrics.ts::wer` exists but `runOnce` doesn't invoke it. Compute when `prompt.reference` is set, write to `metrics.wer`.
8. **`npm run bench` smoke in CI** — a headless matrix + text-only LLM mock plugin for GitHub Actions.
9. **Publish**: `npm publish --access public` once CI is green.
10. **README badge row** (npm, CI, license) once 8–9 land.

## Testing the end-to-end path

```bash
# Requires Ollama running with at least one model pulled
node bin/autobench.js run configs/smoke.yaml --out runs/smoke.jsonl
cat runs/smoke.summary.md
```

First run will include cold model-load latency (~3s for 32B Q4). Re-running with `runs: 2+` confirms the plugin + Ollama cache keep subsequent runs fast (~100–200ms TTFT).

## License

MIT © Very Good Plugins
