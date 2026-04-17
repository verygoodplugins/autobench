import { loadBuiltins, registry } from "../core/registry.js";

async function main() {
  await loadBuiltins();
  const d = registry.describe();
  for (const [slot, names] of Object.entries(d)) {
    console.log(`${slot}:`);
    for (const n of names) console.log(`  - ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
