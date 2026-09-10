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
          // Explicit groups only — NO `maxSize`. Size-based splitting cuts
          // wherever the byte budget runs out, which does not respect a
          // dependency cycle: vendored graphs are full of them (shiki's
          // `class Registry extends Registry$1` landed in a different chunk
          // from its base and evaluated to `undefined`, a hard page-load
          // crash). Each group is one chunk, so a cycle inside a group stays
          // inside it. Lazy routes and dynamic imports still split on their
          // own boundaries, which are cycle-safe by construction.
          groups: [
            // One module per language grammar (~200), reached only through the
            // code-preview dynamic import. No `maxSize`: bucketing by size was
            // VERIFIED to make every lang chunk cyclic (the grammars reference
            // each other), which is the same crash one lazy route later. One
            // lazy chunk, fetched on first code block.
            {
              name: "shiki-langs",
              test: /[\\/]@shikijs[\\/]langs[\\/]/,
              priority: 30,
            },
            {
              name: (id) => (vizOnly.test(id) ? null : "vendor"),
              test: /[\\/]node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
})
