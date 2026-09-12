import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import { responseJson } from "../src/lib/guards"
import { json } from "./support"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-queue-validation-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  const db = new Database(join(path, "aegisx.sqlite"))
  db.run(
    `insert into events (id,name,created_at,updated_at,prompt_brief) values ('e1','E1','t','t','')`
  )
  db.run(
    `insert into challenges (id,event_id,name,description,category,points,created_at,updated_at) values ('c1','e1','C1','','web',100,'t','t')`
  )
  db.close()
  return instance.app
}

/** Insert a pending queue item directly (no model provider is configured in
 * the test env, so the enqueue path cannot hand out a launchable item). */
function insertPendingItem(itemId: string) {
  const path = tempDirs[tempDirs.length - 1]
  const db = new Database(join(path, "aegisx.sqlite"))
  db.run(
    `insert into spawn_queue (id,event_id,ord,challenge_id,params,timeout_ms,prompt,source,status,agent_id,error,created_at,updated_at)
     values (?, 'e1', 1, 'c1', '{}', null, 'p', 'manual', 'pending', null, null, 't', 't')`,
    [itemId]
  )
  db.close()
}

describe("model-ref validation on the queue write surface", () => {
  test("enqueue with an unresolvable model ref is a 400 and writes nothing", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/events/e1/queue",
      json("POST", { challengeId: "c1", model: "nope/hallucinated:off" })
    )
    expect(response.status).toBe(400)
    const body = await responseJson<{
      error: { code: string; message: string }
    }>(response)
    expect(body.error.code).toBe("invalid")
    expect(body.error.message).toContain("nope/hallucinated:off")
    expect(body.error.message).toContain("Available models:")
    const list = await app.request("/api/events/e1/queue")
    const listBody = await responseJson<{ items: unknown[] }>(list)
    expect(listBody.items).toEqual([])
  })

  test("enqueue without a model is accepted (scheduler default applies)", async () => {
    const app = createTestApp()
    const response = await app.request(
      "/api/events/e1/queue",
      json("POST", { challengeId: "c1" })
    )
    expect(response.status).toBe(202)
    const item = await responseJson<{ id: string }>(response)
    expect(item.id).toBeDefined()
  })

  test("queue-item edit carrying an unresolvable params.model is a 400", async () => {
    const app = createTestApp()
    insertPendingItem("q1")
    const response = await app.request(
      "/api/events/e1/queue/q1",
      json("PATCH", { params: { model: "nope/hallucinated:off" } })
    )
    expect(response.status).toBe(400)
    const body = await responseJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe("invalid")
  })

  test("queue-item edit without a model ref is accepted", async () => {
    const app = createTestApp()
    insertPendingItem("q1")
    const response = await app.request(
      "/api/events/e1/queue/q1",
      json("PATCH", { params: { promptMode: "override" }, prompt: "go" })
    )
    expect(response.status).toBe(200)
    const item = await responseJson<{ prompt: string; params: unknown }>(
      response
    )
    expect(item.prompt).toBe("go")
  })
})
