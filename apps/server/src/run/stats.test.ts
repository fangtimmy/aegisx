import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunPublic, UsageSummary } from "../../../shared"
import { createDatabase } from "../db"
import { eventStatistics, isSuccessfulRun } from "./stats"

function usage(partial: Partial<UsageSummary> = {}): UsageSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
    ...partial,
  }
}

function run(partial: Partial<RunPublic> & Pick<RunPublic, "id">): RunPublic {
  return {
    mainAgentId: partial.id,
    challengeId: "ch-1",
    challengeName: "Demo",
    eventId: "ev-1",
    status: "completed",
    provider: "faux",
    modelId: "m1",
    modelName: "Model One",
    thinkingLevel: "off",
    environment: "local",
    targetSupported: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    error: null,
    summary: null,
    hasFlag: false,
    flag: null,
    ...partial,
  }
}

function withDb(
  runFn: (
    db: ReturnType<typeof createDatabase>["db"],
    sqlite: ReturnType<typeof createDatabase>["sqlite"]
  ) => void
) {
  const dataDir = mkdtempSync(join(tmpdir(), "aegisx-stats-"))
  const { db, sqlite, releaseLock } = createDatabase(dataDir)
  try {
    runFn(db, sqlite)
  } finally {
    sqlite.close()
    releaseLock()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe("isSuccessfulRun", () => {
  test("requires completed and flag", () => {
    expect(
      isSuccessfulRun(
        run({ id: "a", status: "completed", flag: "flag{x}", hasFlag: true })
      )
    ).toBe(true)
    expect(
      isSuccessfulRun(run({ id: "b", status: "completed", flag: null }))
    ).toBe(false)
    expect(
      isSuccessfulRun(
        run({ id: "c", status: "failed", flag: "flag{x}", hasFlag: true })
      )
    ).toBe(false)
  })
})

describe("eventStatistics", () => {
  test("aggregates success, models, duration, funnel", () => {
    withDb((db, sqlite) => {
      const now = "2026-01-02T12:00:00.000Z"
      sqlite.run(
        `insert into events (id, name, prompt_hint, created_at, updated_at) values (?, ?, '', ?, ?)`,
        ["ev-1", "E", now, now]
      )
      sqlite.run(
        `insert into challenges (id, event_id, name, category, description, created_at, updated_at)
         values (?, ?, ?, ?, '', ?, ?)`,
        ["ch-1", "ev-1", "Demo", "web", now, now]
      )
      sqlite.run(
        `insert into challenges (id, event_id, name, category, description, created_at, updated_at)
         values (?, ?, ?, ?, '', ?, ?)`,
        ["ch-2", "ev-1", "Other", "pwn", now, now]
      )

      const runs: RunPublic[] = [
        run({
          id: "ok",
          flag: "flag{ok}",
          hasFlag: true,
          provider: "faux",
          modelId: "m1",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:20.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        run({
          id: "no-flag",
          flag: null,
          hasFlag: false,
          provider: "custom",
          modelId: "m2",
          modelName: "Custom",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        run({
          id: "failed",
          status: "failed",
          error: "boom",
          provider: "faux",
          modelId: "m1",
          createdAt: "2026-01-02T00:00:00.000Z",
          startedAt: "2026-01-02T00:00:00.000Z",
          completedAt: "2026-01-02T00:00:08.000Z",
        }),
      ]

      for (const r of runs) {
        sqlite.run(
          `insert into runs (id, challenge_id, status, model_json, env_json, prompt_json, flag, created_at, started_at, updated_at, completed_at, error)
           values (?, ?, ?, '{}', '{"type":"local"}', '{}', ?, ?, ?, ?, ?, ?)`,
          [
            r.id,
            r.challengeId,
            r.status,
            r.flag,
            r.createdAt,
            r.startedAt,
            r.updatedAt,
            r.completedAt,
            r.error,
          ]
        )
      }
      sqlite.run(
        `insert into submissions (id, run_id, flag, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        ["s1", "ok", "flag{ok}", "accepted", now, now]
      )
      sqlite.run(
        `insert into submissions (id, run_id, flag, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        ["s2", "no-flag", "flag{wrong}", "rejected", now, now]
      )

      const usageByRun = new Map<string, UsageSummary>([
        ["ok", usage({ input: 10, output: 5, totalTokens: 15, cost: 0.2 })],
        ["no-flag", usage({ input: 4, output: 2, totalTokens: 6, cost: null })],
        ["failed", usage({ input: 1, output: 1, totalTokens: 2, cost: 0.01 })],
      ])

      const stats = eventStatistics(db, "ev-1", runs, usageByRun)

      expect(stats.successfulRunCount).toBe(1)
      expect(stats.terminalRunCount).toBe(3)
      expect(stats.successRate).toBeCloseTo(1 / 3)
      expect(stats.solvedChallengeCount).toBe(1)
      expect(stats.duration.medianMs).toBe(8000)
      expect(stats.duration.p90Ms).toBe(20000)
      expect(stats.cost.unknownRunCount).toBe(1)
      expect(stats.cost.known).toBeCloseTo(0.21)
      expect(stats.funnel).toMatchObject({
        totalChallenges: 2,
        attemptedChallenges: 1,
        submittedChallenges: 1,
        solvedChallenges: 1,
        totalSubmissions: 2,
        acceptedSubmissions: 1,
        rejectedSubmissions: 1,
        submittedRuns: 2,
        firstAttemptAcceptedRuns: 1,
      })
      expect(stats.models.length).toBe(2)
      expect(
        stats.models.find((m) => m.modelId === "m1")?.successfulRunCount
      ).toBe(1)
      expect(
        stats.failures.some((f) => f.reason === "completed_without_flag")
      ).toBe(true)
      expect(stats.failures.some((f) => f.reason === "boom")).toBe(true)
      expect(stats.trend.length).toBe(2)
      expect(stats.categories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "web",
            challengeCount: 1,
            attemptedCount: 1,
            solvedCount: 1,
          }),
          expect.objectContaining({
            category: "pwn",
            challengeCount: 1,
            attemptedCount: 0,
            solvedCount: 0,
          }),
        ])
      )
      expect(stats.tools).toEqual([])
      expect(
        stats.challenges.find((c) => c.challengeId === "ch-1")?.usage
          .totalTokens
      ).toBe(23)
      expect(stats.runs.filter((r) => r.successful)).toHaveLength(1)
    })
  })
})
