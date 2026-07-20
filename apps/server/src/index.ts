import { resolve } from "node:path"
import { createApp } from "./app"

const dataDir = process.env.AEGISX_DATA_DIR
  ? resolve(process.env.AEGISX_DATA_DIR)
  : resolve(import.meta.dir, "../../../data")
const instance = createApp({ dataDir })
let closing = false

async function shutdown() {
  if (closing) return
  closing = true
  await instance.close()
  process.exit(0)
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)

export default {
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  fetch: instance.app.fetch,
}
