import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.AUTOBENCH_API ?? "http://localhost:8782";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/runs": API_TARGET,
      "/plugins": API_TARGET,
      "/health": API_TARGET,
      "/run": API_TARGET,
      "/playground": API_TARGET,
      "/ollama": API_TARGET,
    },
  },
});
