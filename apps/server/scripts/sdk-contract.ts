/**
 * SDK contract test runner (docs/sdk-refactor.md W5): boots a real app on a
 * temp data dir, seeds fixtures straight into the DB (event + challenge +
 * scheduler/solver agent rows with tokens + three solver session entries),
 * serves it on an ephemeral port, then runs apps/sdk/python/contract.py via
 * uv against the live server. Exit 0 = the SDK and the server agree.
 *
 * Not part of `bun test` (deliberately — it needs uv); run via
 * `bun run test:sdk` from the repo root.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createApp } from "../src/app"
import type { Database } from "../src/db"
import {
  agents,
  challenges,
  events,
  sessionEntries,
  sessions,
} from "../src/db/schema"

const repoRoot = resolve(import.meta.dir, "../../..")
const dataDir = mkdtempSync(join(tmpdir(), "aegisx-sdk-contract-"))
const { app, db, close } = createApp({ dataDir })

const now = new Date().toISOString()
const eventId = "evt-contract"
const challengeId = "ch-contract"
const schedulerId = "agent-scheduler-contract"
const solverId = "agent-solver-contract"
const token = () =>
  crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
const schedulerToken = token()
const solverToken = token()

function seed(db: Database): void {
  db.insert(events)
    .values({
      id: eventId,
      name: "Contract Event",
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(challenges)
    .values({
      id: challengeId,
      eventId,
      name: "Contract Challenge",
      description: "contract fixture",
      category: "pwn",
      points: 100,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  for (const [id, t, challengeId_, role, name] of [
    [schedulerId, schedulerToken, null, "orchestrator", "Scheduler"],
    [solverId, solverToken, challengeId, "solver", "agent-solver"],
  ] as const) {
    db.insert(agents)
      .values({
        id,
        token: t,
        eventId,
        challengeId: challengeId_,
        role,
        name,
        model: "aegisx-contract/model:off",
        systemPrompt: "sys",
        tools: "[]",
        status: "idle",
        sessionFile: id === solverId ? "sess-contract" : null,
        source: "manual",
        timeoutMs: 3_600_000,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run()
  }
  // Three renderable entries so agents.read(last_n=2) can prove the tail cap.
  db.insert(sessions)
    .values({
      id: "sess-contract",
      agentId: solverId,
      cwd: "/workspace",
      createdAt: now,
    })
    .run()
  for (let seq = 1; seq <= 3; seq += 1) {
    db.insert(sessionEntries)
      .values({
        id: `entry-contract-${seq}`,
        sessionId: "sess-contract",
        agentId: solverId,
        parentId: null,
        seq,
        type: "message",
        data: JSON.stringify({
          type: "message",
          message: { role: "user", content: `line ${seq}` },
        }),
        createdAt: now,
      })
      .run()
  }
}

seed(db)

const server = Bun.serve({ port: 0, fetch: app.fetch })
const baseUrl = `http://127.0.0.1:${server.port}`

const proc = Bun.spawn(
  [
    "uv",
    "run",
    "--project",
    "apps/sdk/python",
    "python",
    "apps/sdk/python/contract.py",
    `--base-url=${baseUrl}`,
    `--event-id=${eventId}`,
    `--challenge-id=${challengeId}`,
    `--scheduler-token=${schedulerToken}`,
    `--scheduler-id=${schedulerId}`,
    `--solver-token=${solverToken}`,
    `--solver-id=${solverId}`,
  ],
  { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
)

const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])
process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)

void server.stop(true)
await close()

if (code !== 0) {
  console.error(`SDK contract test FAILED (exit ${code})`)
  process.exit(1)
}
console.log("SDK contract test passed")
process.exit(0)
