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
    // rolldown's advancedChunks takes FULL control of splitting: modules not
    // matched by any group are inlined into their importer, so these groups
    // cover everything that should be a chunk of its own.
    chunkSizeWarningLimit: 8_000,
    rolldownOptions: {
      output: {
        advancedChunks: {
          includeDependenciesRecursively: true,
          groups: [
            // Shiki loads each language grammar via its own dynamic import,
            // which otherwise emits ~120 sub-10KB chunks; keep them in one
            // lazy chunk fetched on the first highlighted block.
            {
              name: "shiki-langs",
              test: /[\\/]@shikijs[\\/]langs[\\/]/,
              priority: 30,
            },
            {
              name: "event-page",
              test: /[\\/]features[\\/]events[\\/]event-page[\\/]/,
              priority: 20,
            },
            {
              name: "settings-page",
              test: /[\\/]features[\\/]settings[\\/]settings-page[\\/]/,
              priority: 20,
            },
            { name: "vendor", test: /[\\/]node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
})
