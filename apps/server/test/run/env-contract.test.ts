import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  SDK_CONTAINER_ENV,
  SDK_EXEC_ENV,
  sdkContainerEnv,
  sdkExecEnv,
} from "../../src/run/container/env-contract"

const SERVER_SRC = fileURLToPath(new URL("../../src", import.meta.url))
const SDK_DIR = fileURLToPath(new URL("../../../sdk/python", import.meta.url))
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

const CONTRACT_NAMES = [
  SDK_CONTAINER_ENV.eventId,
  SDK_CONTAINER_ENV.apiUrl,
  SDK_EXEC_ENV.agentId,
  SDK_EXEC_ENV.token,
].toSorted()

describe("env contract (server injection ↔ docs/env.md ↔ Python SDK)", () => {
  // The SDK's auth/routing depends on four variable names. The server builds
  // them through env-contract.ts, the SDK reads them in client.py/channels.py,
  // and docs/env.md documents them. Any rename must move all three sides —
  // these assertions fail until it does.

  test("builders emit the declared names", () => {
    expect(sdkContainerEnv("evt-1", "http://host:3000")).toEqual([
      "AEGISX_EVENT_ID=evt-1",
      "AEGISX_API_URL=http://host:3000",
    ])
    expect(sdkExecEnv("agent-1", "tok")).toEqual([
      "AEGISX_AGENT_ID=agent-1",
      "AEGISX_TOKEN=tok",
    ])
  })

  test("the server builds SDK env only through the contract", () => {
    // The `NAME=` assignment form must appear nowhere in server source
    // outside the contract module (a raw literal elsewhere is a fork).
    const paths = [
      ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SERVER_SRC }),
    ].filter((path) => !path.endsWith("container/env-contract.ts"))
    for (const name of CONTRACT_NAMES) {
      const assignment = `${name}=`
      const hit = paths.some((path) =>
        readFileSync(join(SERVER_SRC, path), "utf8").includes(assignment)
      )
      expect(hit).toBe(false)
    }
  })

  test("the Python SDK reads exactly the contracted names", () => {
    const read = new Set<string>()
    for (const path of new Bun.Glob("**/*.py").scanSync({ cwd: SDK_DIR })) {
      const source = readFileSync(join(SDK_DIR, path), "utf8")
      for (const match of source.matchAll(
        /os\.environ\.get\(\s*"([A-Z_]+)"/g
      )) {
        read.add(match[1])
      }
    }
    expect([...read].toSorted()).toEqual(CONTRACT_NAMES)
  })

  test("docs/env.md documents the exec-injected names", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs/env.md"), "utf8")
    for (const name of CONTRACT_NAMES) {
      expect(doc).toContain(`\`${name}\``)
    }
  })
})
