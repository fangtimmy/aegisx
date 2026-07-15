import { resolve } from "node:path"
import { createApp } from "./app"

const dataDir = process.env.AEGISX_DATA_DIR
  ? resolve(process.env.AEGISX_DATA_DIR)
  : resolve(import.meta.dir, "../../../data")
const { app } = createApp({ dataDir })

export default {
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
}
