import { startServer } from "../server.js";

const port = Number(process.env.AUTOBENCH_PORT ?? 8782);
startServer({ port }).catch((e) => {
  console.error(e);
  process.exit(1);
});
