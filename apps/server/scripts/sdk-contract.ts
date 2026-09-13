/**
 * SDK test runner (design notes in docs/archive/sdk-refactor.md): boots a real
 * app on a temp data dir, seeds fixtures straight into the DB (event +
 * challenge + scheduler/solver agent rows with tokens + three solver session
 * entries), serves it on an ephemeral port, then runs apps/sdk/python via uv
 * against the live server — contract.py (HTTP contract) plus test_models.py
 * (wire mapping / time visibility, stdlib unittest). Exit 0 = the SDK and the
 * server agree.
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
import { mintAgentToken } from "../src/infrastructure/agent-credentials"

const repoRoot = resolve(import.meta.dir, "../../..")
const dataDir = mkdtempSync(join(tmpdir(), "aegisx-sdk-contract-"))
const { app, db, close } = createApp({ dataDir })

const now = new Date().toISOString()
const eventId = "evt-contract"
const challengeId = "ch-contract"
const schedulerId = "agent-scheduler-contract"
const solverId = "agent-solver-contract"
// Disposable second solver: seeded TERMINAL (aborted) so the submit_plan
// wrong_state path has a fresh (non-self) agent id to be asserted against.
const solver2Id = "agent-solver2-contract"
// Credentials are minted per-boot (no DB column): the harness mints through
// the same module the exec path uses — valid ~1h, plenty for the run.
const schedulerToken = mintAgentToken(schedulerId)
const solverToken = mintAgentToken(solverId)

function seed(database: Database): void {
  database
    .insert(events)
    .values({
      id: eventId,
      name: "Contract Event",
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database
    .insert(challenges)
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
  for (const [id, challengeId_, role, name, status] of [
    [schedulerId, null, "orchestrator", "Scheduler", "idle"],
    [solverId, challengeId, "solver", "agent-solver", "idle"],
    [solver2Id, challengeId, "solver", "agent-solver2", "aborted"],
  ] as const) {
    database
      .insert(agents)
      .values({
        id,
        eventId,
        challengeId: challengeId_,
        role,
        name,
        model: "aegisx-contract/model:off",
        systemPrompt: "sys",
        tools: "[]",
        status,
        sessionFile: id === solverId ? "sess-contract" : null,
        source: "manual",
        timeoutMs: 3_600_000,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run()
  }
  // Three renderable entries so agents.read(limit=2) can prove the tail cap.
  database
    .insert(sessions)
    .values({
      id: "sess-contract",
      agentId: solverId,
      cwd: "/workspace",
      createdAt: now,
    })
    .run()
  for (let seq = 1; seq <= 3; seq += 1) {
    database
      .insert(sessionEntries)
      .values({
        id: `entry-contract-${seq}`,
        sessionId: "sess-contract",
        agentId: solverId,
        parentId: null,
        seq,
        type: "message",
        role: "user",
        createdAt: now,
        body: JSON.stringify({
          kind: "message",
          payload: { message: { role: "user", content: `line ${seq}` } },
        }),
      })
      .run()
  }
}

seed(db)

const server = Bun.serve({ port: 0, fetch: app.fetch })
const baseUrl = `http://127.0.0.1:${server.port}`

const uv = ["uv", "run", "--project", "apps/sdk/python", "python"]

async function run(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return { stdout, stderr, code }
}

async function shutdown(failed: boolean, message: string): Promise<never> {
  void server.stop(true)
  await close()
  if (failed) {
    console.error(message)
    process.exit(1)
  }
  console.log("SDK contract test passed")
  process.exit(0)
}

// Wire mapping / time visibility unit tests (stdlib unittest, no server).
// cwd is the SDK project so uv discovers its pyproject and the module resolves.
const models = await run(
  ["uv", "run", "python", "-m", "unittest", "test_models", "-v"],
  join(repoRoot, "apps/sdk/python")
)
if (models.code !== 0) {
  await shutdown(true, `SDK model tests FAILED (exit ${models.code})`)
}

const contract = await run(
  [
    ...uv,
    "apps/sdk/python/contract.py",
    `--base-url=${baseUrl}`,
    `--event-id=${eventId}`,
    `--challenge-id=${challengeId}`,
    `--scheduler-token=${schedulerToken}`,
    `--scheduler-id=${schedulerId}`,
    `--solver-token=${solverToken}`,
    `--solver-id=${solverId}`,
    `--solver2-id=${solver2Id}`,
  ],
  repoRoot
)
if (contract.code !== 0) {
  await shutdown(true, `SDK contract test FAILED (exit ${contract.code})`)
}
await shutdown(false, "")
