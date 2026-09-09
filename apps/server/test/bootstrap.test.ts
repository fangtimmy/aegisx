import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import {
  ensurePresetSettings,
  readBootstrapSpec,
  readEventPreset,
  runBootstrap,
  type BootstrapDeps,
  type EventPreset,
} from "../src/bootstrap"
import { events } from "../src/db/schema"
import type { ConfigStore } from "../src/infrastructure/config-store"
import { setupDb } from "./helpers"
import { refine } from "./support"

/** Minimal ConfigStore double over a plain settings record. */
function fakeConfigStore(settings: Record<string, string | number | boolean>) {
  return refine<ConfigStore>({
    getSettings: () => settings,
    updateSettings: (patch: Record<string, string | number | boolean>) => {
      Object.assign(settings, patch)
    },
  })
}

function fakeAgentService(applied: Array<Record<string, unknown>>) {
  return refine<BootstrapDeps["agentService"]>({
    upsertSchedulerConfig: (patch: Record<string, unknown>) => {
      applied.push(patch)
    },
    getSchedulerConfig: () => ({ instruction: "" }),
    // An already-active scheduler agent keeps ensureScheduler past its
    // startScheduler branch (these tests don't exercise agent spawning).
    getSchedulerAgent: () => ({ id: "sched-1", status: "idle" }),
    startScheduler: async () => {
      throw new Error("not reached: these tests stop before scheduler start")
    },
    queue: () => {
      throw new Error("not reached: these tests stop before queueing")
    },
  })
}

describe("bootstrap event preset", () => {
  const dir = mkdtempSync(join(tmpdir(), "aegisx-preset-test-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("missing preset file reads as null", () => {
    expect(readEventPreset(join(dir, "absent.json"))).toBeNull()
  })

  test("malformed preset is skipped, not thrown", () => {
    const path = join(dir, "broken.json")
    writeFileSync(path, "{ not json")
    expect(readEventPreset(path)).toBeNull()
  })

  test("preset settings converge onto the store (drift-only writes)", () => {
    const settings: Record<string, string | number | boolean> = {
      "scheduler.defaultRunTimeoutMs": 3_600_000,
      "scheduler.maxConcurrentAgents": 4,
    }
    const store = fakeConfigStore(settings)
    const preset: EventPreset = {
      settings: {
        "scheduler.defaultRunTimeoutMs": 1_800_000,
        "scheduler.maxConcurrentAgents": 4,
      },
    }
    ensurePresetSettings(store, preset)
    expect(settings["scheduler.defaultRunTimeoutMs"]).toBe(1_800_000)
  })

  test("runBootstrap applies promptHint and scheduler policy on first boot", async () => {
    const dbh = setupDb()
    try {
      const presetPath = join(dir, "tsec.json")
      writeFileSync(
        presetPath,
        JSON.stringify({
          promptHint: "平台：TSecBench",
          settings: { "scheduler.defaultRunTimeoutMs": 1_800_000 },
          scheduler: { maxConcurrentTargets: 3, stopSubmitterOnSolve: true },
        })
      )
      const settings: Record<string, string | number | boolean> = {}
      const applied: Array<Record<string, unknown>> = []
      const deps: BootstrapDeps = {
        db: dbh.db,
        configStore: fakeConfigStore(settings),
        platformService: refine<BootstrapDeps["platformService"]>({}),
        agentService: fakeAgentService(applied),
        presetPath,
      }
      await runBootstrap(
        deps,
        readBootstrapSpec({ AEGISX_EVENT_NAME: "preset-evt" })
      )

      const event = dbh.db
        .select()
        .from(events)
        .all()
        .find((e) => e.name === "preset-evt")
      expect(event?.promptHint).toBe("平台：TSecBench")
      expect(settings["scheduler.defaultRunTimeoutMs"]).toBe(1_800_000)
      expect(applied).toHaveLength(1)
      expect(applied[0].maxConcurrentTargets).toBe(3)
      expect(applied[0].stopSubmitterOnSolve).toBe(true)
    } finally {
      dbh.close()
    }
  })

  test("re-bootstrap backfills an empty promptHint but never overwrites a set one", async () => {
    const dbh = setupDb()
    try {
      const presetPath = join(dir, "hint.json")
      writeFileSync(presetPath, JSON.stringify({ promptHint: "v2 简报" }))
      const deps: BootstrapDeps = {
        db: dbh.db,
        configStore: fakeConfigStore({}),
        platformService: refine<BootstrapDeps["platformService"]>({}),
        agentService: fakeAgentService([]),
        presetPath,
      }
      const spec = readBootstrapSpec({ AEGISX_EVENT_NAME: "hint-evt" })
      await runBootstrap(deps, spec)
      // User (or an older image) set a hint afterwards — the preset must not
      // clobber it on the next boot.
      dbh.db
        .update(events)
        .set({ promptHint: "用户改过的简报" })
        .where(eq(events.name, "hint-evt"))
        .run()
      await runBootstrap(deps, spec)
      const event = dbh.db
        .select()
        .from(events)
        .all()
        .find((e) => e.name === "hint-evt")
      expect(event?.promptHint).toBe("用户改过的简报")
    } finally {
      dbh.close()
    }
  })
})
