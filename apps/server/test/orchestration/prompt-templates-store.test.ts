import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { promptTemplates } from "../../src/db/schema"
import {
  BUILTIN_DEFAULTS,
  BUILTIN_PLUGIN,
  loadTemplateMap,
  renderTemplate,
  seedBuiltinTemplates,
} from "../../src/orchestration/prompt-templates"
import { setupDb } from "../helpers"

describe("prompt_templates store (builtin-only)", () => {
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
})
