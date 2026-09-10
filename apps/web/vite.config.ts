import path from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Packages only reachable from the lazy /events route (graphs & charts and
// their private stacks). Returned as null from the vendor name() below so
// they fall through to automatic chunking, which places them inside the lazy
// event-page chunk — the vendor catch-all would otherwise hoist them into the
// eager graph. bun's store layout (`node_modules/.bun/x@h/node_modules/x/`)
// has two node_modules segments, so a negative lookahead on the vendor test
// cannot express this exclusion.
const vizOnly =
  /[\\/](recharts|@reduxjs|react-redux|reselect|immer|victory-vendor|d3-[a-z-]+|@xyflow|zustand|classcat|@dagrejs)[\\/]/

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
    // Chunk budget: 500 kB – 2 MB per chunk (uncompressed). Groups only pin
    // down module sets whose default placement would be wrong; maxSize makes
    // rolldown split anything over budget automatically.
    chunkSizeWarningLimit: 2_000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // One module per language grammar (~200); maxSize buckets them
            // into mid-size chunks fetched on first use of any grammar inside.
            {
              name: "shiki-langs",
              test: /[\\/]@shikijs[\\/]langs[\\/]/,
              priority: 30,
              maxSize: 1_500_000,
            },
            {
              name: (id) => (vizOnly.test(id) ? null : "vendor"),
              test: /[\\/]node_modules[\\/]/,
              priority: 10,
              maxSize: 2_000_000,
            },
          ],
        },
      },
    },
  },
})
