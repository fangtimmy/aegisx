import { resolve } from "node:path"

import { createApp } from "./app"

const dataDir = process.env.AEGISX_DATA_DIR
  ? resolve(process.env.AEGISX_DATA_DIR)
  : resolve(import.meta.dir, "../../../data")
const instance = createApp({ dataDir })
let closing = false

async function shutdown(force = false) {
  // A repeat signal (or an explicit force) tears the process down without
  // waiting for graceful close — the first signal may be stuck in instance.close().
  if (force) process.exit(1)
  if (closing) return
  closing = true
  await instance.close()
  process.exit(0)
}

process.on("SIGINT", () => shutdown(closing))
process.on("SIGTERM", () => shutdown(closing))

// Pin the runtime defaults explicitly: rejections log and stay alive,
// exceptions log and exit (state after one is suspect).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", {
    error:
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : String(reason),
  })
})
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", {
    error: { message: error.message, stack: error.stack },
  })
  process.exit(1)
})

export default {
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  // Bun.serve default idleTimeout is 10s; quiet SSE (thinking / long tools) is idle
  // and gets reset mid-stream. 0 disables. See bun docs: guides/http/sse.
  idleTimeout: 0,
  fetch: instance.app.fetch,
}
