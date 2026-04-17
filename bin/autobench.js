#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...rest] = process.argv;

const targets = {
  run: "../dist/cli/run.js",
  serve: "../dist/cli/serve.js",
  list: "../dist/cli/list.js",
};

if (!cmd || !(cmd in targets)) {
  console.error("usage: autobench <run|serve|list> [args]");
  process.exit(1);
}

process.argv = [process.argv[0], process.argv[1], ...rest];
await import(pathToFileURL(resolve(__dirname, targets[cmd])).href);
