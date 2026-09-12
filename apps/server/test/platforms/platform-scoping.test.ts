import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../../src/app"

const tempDirs: string[] = []
const closeDatabases: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closeDatabases.splice(0)) await close()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createTestApp() {
  const path = mkdtempSync(join(tmpdir(), "aegisx-platform-scoping-"))
  tempDirs.push(path)
  const instance = createApp({ dataDir: path })
  closeDatabases.push(instance.close)
  return { ...instance, dataDir: path }
}

/** Two events bound to the SAME platform sourceKey, each with one imported
 * challenge. Raw rows: exercising the sourceKey collision needs no live
 * platform — the detach path only touches the DB for an unbound ctfd site. */
function seedSharedSource(dataDir: string, sourceKey: string) {
  const db = new Database(join(dataDir, "aegisx.sqlite"))
  const t = new Date().toISOString()
  db.run(
    `insert into events (id,name,created_at,updated_at,prompt_brief) values
     ('e1','E1','${t}','${t}',''),('e2','E2','${t}','${t}','')`
  )
  db.run(
    `insert into event_platforms (event_id,type,base_url,credential,source_key,remote_event_id,created_at,updated_at) values
     ('e1','ctfd','https://ctf.example.com','cred1','${sourceKey}','site','${t}','${t}'),
     ('e2','ctfd','https://ctf.example.com','cred2','${sourceKey}','site','${t}','${t}')`
  )
  db.run(
    `insert into challenges (id,event_id,name,description,category,points,created_at,updated_at) values
     ('c1','e1','C1','','web',100,'${t}','${t}'),('c2','e2','C2','','web',100,'${t}','${t}')`
  )
  db.run(
    `insert into challenge_remote (challenge_id,event_id,source_key,remote_id,available,solved,target_supported,target_ignored,target_count,target_info,synced_at) values
     ('c1','e1','${sourceKey}','r1',1,0,0,0,0,'[]','${t}'),
     ('c2','e2','${sourceKey}','r2',1,0,0,0,0,'[]','${t}')`
  )
  return db
}

describe("platform challenge_remote scoping", () => {
  test("detaching one event leaves the shared-source mappings of other events available", async () => {
    const { app, dataDir } = createTestApp()
    const sourceKey = JSON.stringify([
      "ctfd",
      "https://ctf.example.com",
      "site",
    ])
    const sqlite = seedSharedSource(dataDir, sourceKey)

    const response = await app.request("/api/events/e1/platform", {
      method: "DELETE",
    })
    expect(response.status).toBe(204)

    const remote = (id: string) =>
      sqlite
        .query<{ available: number }, [string]>(
          "select available from challenge_remote where challenge_id = ?"
        )
        .get(id)?.available
    expect(remote("c1")).toBe(0)
    expect(remote("c2")).toBe(1)
    sqlite.close()
  })
})
