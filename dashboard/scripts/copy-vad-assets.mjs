import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = dirname(here);
const repoRoot = dirname(dashboardRoot);
const dest = join(dashboardRoot, "public", "vad");

// npm may hoist deps to the repo-root node_modules (no workspaces declared,
// but shared deps dedupe upward). Search both locations.
// vad-web pins onnxruntime-web@1.14 internally. Prefer its nested install so
// the WASM filenames match the JS loader; fall back to any top-level install.
const searchRoots = [
  join(dashboardRoot, "node_modules", "@ricky0123/vad-web/node_modules"),
  join(repoRoot, "node_modules", "@ricky0123/vad-web/node_modules"),
  join(dashboardRoot, "node_modules"),
  join(repoRoot, "node_modules"),
];

const assets = [
  { from: "@ricky0123/vad-web/dist/silero_vad_legacy.onnx", as: "silero_vad_legacy.onnx" },
  { from: "@ricky0123/vad-web/dist/silero_vad_v5.onnx", as: "silero_vad_v5.onnx" },
  { from: "@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", as: "vad.worklet.bundle.min.js" },
  // onnxruntime-web 1.14 loads one of these four depending on detected capabilities
  { from: "onnxruntime-web/dist/ort-wasm.wasm", as: "ort-wasm.wasm" },
  { from: "onnxruntime-web/dist/ort-wasm-simd.wasm", as: "ort-wasm-simd.wasm" },
  { from: "onnxruntime-web/dist/ort-wasm-threaded.wasm", as: "ort-wasm-threaded.wasm" },
  { from: "onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", as: "ort-wasm-simd-threaded.wasm" },
];

mkdirSync(dest, { recursive: true });

const missing = [];
let copied = 0;
for (const { from, as } of assets) {
  const src = searchRoots.map((r) => join(r, from)).find(existsSync);
  if (!src) {
    missing.push(from);
    continue;
  }
  copyFileSync(src, join(dest, as));
  copied++;
}

console.log(`[copy-vad-assets] copied ${copied}/${assets.length} files into ${dest}`);
if (missing.length) {
  console.warn(`[copy-vad-assets] missing (ok if this is a pre-install run): ${missing.join(", ")}`);
}
