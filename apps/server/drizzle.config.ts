import { defineConfig } from "drizzle-kit"
import { resolve } from "node:path"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: resolve("../../../data/aegisx.sqlite") },
})
