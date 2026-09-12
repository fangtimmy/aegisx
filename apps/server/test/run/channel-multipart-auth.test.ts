import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../../src/app"
import { responseJson } from "../../src/lib/guards"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-channel-multipart-auth-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  const db = new Database(join(path, "aegisx.sqlite"))
  db.run(
    `insert into events (id,name,created_at,updated_at,prompt_brief) values ('e1','E1','t','t',''),('e2','E2','t','t','')`
  )
  db.run(
    `insert into challenges (id,event_id,name,description,category,points,created_at,updated_at) values ('c2','e2','C2','','web',100,'t','t')`
  )
  db.run(
    `insert into agents (id,token,event_id,challenge_id,role,model,system_prompt,tools,status,source,created_at,updated_at) values ('solver-e1','SOLVER-TOKEN','e1',null,'solver','m','p','[]','running','manual','t','t')`
  )
  db.close()
  return instance
}

function multipartForm(text: string): FormData {
  const form = new FormData()
  form.set("text", text)
  return form
}

describe("POST /api/channels/:channelKey/messages — multipart author face", () => {
  test("rejects a token-bearing multipart post with 400", async () => {
    const { app } = createTestApp()
    const response = await app.request("/api/channels/team:c2/messages", {
      method: "POST",
      headers: { authorization: "Bearer SOLVER-TOKEN" },
      body: multipartForm("hi"),
    })
    expect(response.status).toBe(400)
  })

  test("keeps the tokenless multipart user face working (201, user author)", async () => {
    const { app } = createTestApp()
    const response = await app.request("/api/channels/team:c2/messages", {
      method: "POST",
      body: multipartForm("hi"),
    })
    expect(response.status).toBe(201)
    const message = await responseJson<{ authorType: string }>(response)
    expect(message.authorType).toBe("user")
  })

  test("JSON post with the solver token stays 400 on a foreign-event channel", async () => {
    const { app } = createTestApp()
    const response = await app.request("/api/channels/team:c2/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer SOLVER-TOKEN",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    })
    expect(response.status).toBe(400)
  })
})
