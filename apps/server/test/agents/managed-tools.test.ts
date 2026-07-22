import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { manageAgentTools } from "../../src/agents/managed-tools"
import { createDatabase } from "../../src/db"

const roots: string[] = []
const databases: Array<ReturnType<typeof createDatabase>> = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.sqlite.close()
    database.releaseLock()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aegisx-managed-tools-"))
  roots.push(root)
  const database = createDatabase(root)
  databases.push(database)
  const now = new Date().toISOString()
  database.sqlite.run(
    "insert into events (id, name, created_at, updated_at) values ('event', 'Event', ?, ?)",
    [now, now]
  )
  database.sqlite.run(
    "insert into challenges (id, event_id, name, description, created_at, updated_at) values ('challenge', 'event', 'Challenge', '', ?, ?)",
    [now, now]
  )
  database.sqlite.run(
    "insert into runs (id, challenge_id, status, created_at, updated_at) values ('run', 'challenge', 'running', ?, ?)",
    [now, now]
  )
  database.sqlite.run(
    "insert into run_agents (id, run_id, name, status, created_at, updated_at) values ('agent', 'run', 'Agent', 'running', ?, ?)",
    [now, now]
  )
  return database
}

function hangingTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => new Promise(() => undefined),
  }
}

test("times out platform tools and persists terminal states", async () => {
  const { db, sqlite } = setup()
  const tools = manageAgentTools(
    db,
    "agent",
    [hangingTool("start_target"), hangingTool("submit_flag")],
    (name) => (name === "start_target" ? 20 : 30)
  )

  await expect(tools[0].execute("start-call", {}, undefined)).rejects.toThrow(
    "start_target timed out after 1 seconds"
  )
  await expect(tools[1].execute("submit-call", {}, undefined)).rejects.toThrow(
    "submit_flag timed out after 1 seconds"
  )

  expect(
    sqlite
      .query(
        "select tool_name, status, timeout_ms, succeeded, completed_at from agent_tool_calls order by created_at"
      )
      .all()
  ).toEqual([
    {
      tool_name: "start_target",
      status: "timed_out",
      timeout_ms: 20,
      succeeded: 0,
      completed_at: expect.any(String),
    },
    {
      tool_name: "submit_flag",
      status: "timed_out",
      timeout_ms: 30,
      succeeded: 0,
      completed_at: expect.any(String),
    },
  ])
})

test("cancels a tool even when its promise ignores abort", async () => {
  const { db, sqlite } = setup()
  const [tool] = manageAgentTools(
    db,
    "agent",
    [hangingTool("bash")],
    () => 10_000
  )
  const controller = new AbortController()
  const executing = tool.execute("cancel-call", {}, controller.signal)

  controller.abort()
  await expect(executing).rejects.toThrow("bash was cancelled")
  expect(
    sqlite
      .query(
        "select status, succeeded, error from agent_tool_calls where tool_call_id = 'cancel-call'"
      )
      .get()
  ).toEqual({
    status: "cancelled",
    succeeded: 0,
    error: "bash was cancelled",
  })
})
