import path from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL ?? "http://127.0.0.1:3000",
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["@aegisx/shared"],
  },
  build: {
    // The warning targets apps that should split; here one file is the point.
    chunkSizeWarningLimit: 12_000,
    rollupOptions: {
      output: {
        // Single-machine deployment: ship one JS file instead of ~320 chunks
        // (shiki alone emits one sub-10KB chunk per language grammar). Route
        // lazy-loading disappears, which costs nothing on localhost.
        inlineDynamicImports: true,
      },
    },
  },
})
