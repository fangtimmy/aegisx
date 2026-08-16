import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { promptTemplates } from "../../src/db/schema"
import {
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE_V9,
  LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V10_SDK,
} from "../../src/orchestration/prompt-defaults"
import {
  BUILTIN_DEFAULTS,
  BUILTIN_PLUGIN,
  loadTemplateMap,
  migrateLegacyPromptSettings,
  renderTemplate,
  seedBuiltinTemplates,
  upgradeBuiltinTemplate,
} from "../../src/orchestration/prompt-templates"
import { setupDb } from "../helpers"

describe("prompt_templates store (v9: builtin-only)", () => {
  test("seedBuiltinTemplates inserts the 4 builtin rows", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      const rows = db.select().from(promptTemplates).all()
      const keys = rows.map((r) => r.key).sort()
      expect(keys).toEqual(
        [
          "initial",
          "mainSystem",
          "orchestratorSystem",
          "schedulerInitial",
        ].sort()
      )
      for (const row of rows) {
        expect(row.plugin).toBe(BUILTIN_PLUGIN)
        expect(row.body).toBe(BUILTIN_DEFAULTS[row.key])
      }
    } finally {
      close()
    }
  })

  test("seedBuiltinTemplates is idempotent (second call is a no-op)", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // Simulate a user edit: overwrite the mainSystem body.
      db.update(promptTemplates)
        .set({ body: "USER-EDITED", updatedAt: "x" })
        .where(eq(promptTemplates.key, "mainSystem"))
        .run()
      // Re-seed must NOT clobber the user edit.
      seedBuiltinTemplates(db)
      const row = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "mainSystem"))
        .get()
      expect(row?.body).toBe("USER-EDITED")
    } finally {
      close()
    }
  })

  test("loadTemplateMap: builtin keys only (plugin rows are ignored)", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // A stale plugin-owned row (pre-v9 remnant) must not leak into the map.
      db.insert(promptTemplates)
        .values({
          plugin: "observer-solver",
          key: "observerSystem",
          body: "STALE-PLUGIN",
          updatedAt: "x",
        })
        .run()
      const map = loadTemplateMap(db)
      expect(map.has("observerSystem")).toBe(false)
      expect(map.has("mainSystem")).toBe(true)
      expect(map.get("mainSystem")).toBe(BUILTIN_DEFAULTS.mainSystem)
    } finally {
      close()
    }
  })

  test("renderTemplate: missing key throws", () => {
    const map = new Map<string, string>([["mainSystem", "x"]])
    expect(() => renderTemplate(map, "nope", {})).toThrow(
      "Prompt template not found: nope"
    )
  })

  test("renderTemplate: empty body renders to empty string (no fallback)", () => {
    const map = new Map<string, string>([["mainSystem", ""]])
    expect(renderTemplate(map, "mainSystem", {})).toBe("")
  })

  test("upgradeBuiltinTemplate refreshes only rows still equal to the legacy default", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // mainSystem: simulate a pre-v9 DB (row still carries the v8 default
      // body). orchestratorSystem: user-edited — must survive untouched.
      db.update(promptTemplates)
        .set({ body: LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE_V9, updatedAt: "x" })
        .where(eq(promptTemplates.key, "mainSystem"))
        .run()
      db.update(promptTemplates)
        .set({ body: "USER-EDITED", updatedAt: "x" })
        .where(eq(promptTemplates.key, "orchestratorSystem"))
        .run()

      upgradeBuiltinTemplate(
        db,
        "mainSystem",
        LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE_V9,
        DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE
      )
      upgradeBuiltinTemplate(
        db,
        "orchestratorSystem",
        "never-matched-body",
        "new-body"
      )

      const main = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "mainSystem"))
        .get()
      expect(main?.body).toBe(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE)
      const orch = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "orchestratorSystem"))
        .get()
      expect(orch?.body).toBe("USER-EDITED")
      // A row with the CURRENT default is left alone too (not the legacy body).
      const initial = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "initial"))
        .get()
      expect(initial?.body).toBe(BUILTIN_DEFAULTS.initial)
    } finally {
      close()
    }
  })

  test("orchestratorSystem inbox rework refreshes exact legacy rows (P3)", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // Simulate a pre-inbox DB: the row still carries the v10 SDK-era body.
      db.update(promptTemplates)
        .set({
          body: LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V10_SDK,
          updatedAt: "x",
        })
        .where(eq(promptTemplates.key, "orchestratorSystem"))
        .run()
      expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).not.toBe(
        LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V10_SDK
      )
      upgradeBuiltinTemplate(
        db,
        "orchestratorSystem",
        LEGACY_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE_V10_SDK,
        DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE
      )
      const orch = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "orchestratorSystem"))
        .get()
      expect(orch?.body).toBe(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE)
      // The new default carries the passive-inbox model + no-poll warning.
      expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
        "passive inbox"
      )
      expect(DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE).toContain(
        "NEVER run long polling"
      )
    } finally {
      close()
    }
  })

  test("migrateLegacyPromptSettings: carries user edits, leaves the rest", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      migrateLegacyPromptSettings(db, {
        mainSystem: "CUSTOM-MAIN",
        initial: "CUSTOM-INITIAL",
      })
      const main = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "mainSystem"))
        .get()
      expect(main?.body).toBe("CUSTOM-MAIN")
      const initial = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "initial"))
        .get()
      expect(initial?.body).toBe("CUSTOM-INITIAL")
      // Untouched keys keep the seeded default.
      const orch = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "orchestratorSystem"))
        .get()
      expect(orch?.body).toBe(BUILTIN_DEFAULTS.orchestratorSystem)
    } finally {
      close()
    }
  })

  test("migrateLegacyPromptSettings: never clobbers a table-customized row", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // A v8-era edit made directly in the table wins over legacy config.
      db.update(promptTemplates)
        .set({ body: "TABLE-EDIT" })
        .where(eq(promptTemplates.key, "mainSystem"))
        .run()
      migrateLegacyPromptSettings(db, { mainSystem: "LEGACY-EDIT" })
      const row = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "mainSystem"))
        .get()
      expect(row?.body).toBe("TABLE-EDIT")
    } finally {
      close()
    }
  })

  test("migrateLegacyPromptSettings: an untouched (default) legacy value is a no-op", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      migrateLegacyPromptSettings(db, {
        mainSystem: BUILTIN_DEFAULTS.mainSystem,
      })
      const row = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "mainSystem"))
        .get()
      expect(row?.body).toBe(BUILTIN_DEFAULTS.mainSystem)
    } finally {
      close()
    }
  })
})
