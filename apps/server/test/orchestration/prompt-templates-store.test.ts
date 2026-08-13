import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { promptTemplates } from "../../src/db/schema"
import {
  BUILTIN_DEFAULTS,
  BUILTIN_PLUGIN,
  loadTemplateMap,
  renderTemplate,
  seedBuiltinTemplates,
  seedPluginTemplates,
} from "../../src/orchestration/prompt-templates-store"
import { setupDb } from "../helpers"

describe("prompt_templates store (spec §3.6)", () => {
  test("seedBuiltinTemplates inserts the 4 builtin rows", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      const rows = db.select().from(promptTemplates).all()
      const keys = rows.map((r) => r.key).sort()
      expect(keys).toEqual(
        ["childSystem", "initial", "mainSystem", "orchestratorSystem"].sort()
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

  test("loadTemplateMap: builtin keys present; plugin overrides same key", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // A plugin with its own mainSystem + a custom key.
      db.insert(promptTemplates)
        .values([
          {
            plugin: "myplugin",
            key: "mainSystem",
            body: "PLUGIN-MAIN",
            updatedAt: "x",
          },
          {
            plugin: "myplugin",
            key: "observerSystem",
            body: "PLUGIN-OBS",
            updatedAt: "x",
          },
        ])
        .run()
      const map = loadTemplateMap(db, "myplugin")
      // plugin's mainSystem wins over builtin.
      expect(map.get("mainSystem")).toBe("PLUGIN-MAIN")
      // plugin-only key present.
      expect(map.get("observerSystem")).toBe("PLUGIN-OBS")
      // builtin-only key present (initial).
      expect(map.get("initial")).toBe(BUILTIN_DEFAULTS.initial)
    } finally {
      close()
    }
  })

  test("loadTemplateMap: a different plugin does not see another plugin's keys", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      db.insert(promptTemplates)
        .values({
          plugin: "observer-solver",
          key: "observerSystem",
          body: "OBS",
          updatedAt: "x",
        })
        .run()
      // classic's map should NOT include observer-solver's key.
      const map = loadTemplateMap(db, "classic")
      expect(map.has("observerSystem")).toBe(false)
      expect(map.has("mainSystem")).toBe(true)
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

  test("seedPluginTemplates: no-op for plugins without templates", () => {
    const { db, close } = setupDb()
    try {
      seedPluginTemplates(db, { id: "classic" /* no templates */ })
      expect(db.select().from(promptTemplates).all()).toHaveLength(0)
    } finally {
      close()
    }
  })

  test("seedPluginTemplates: inserts declared defaults, idempotent", () => {
    const { db, close } = setupDb()
    try {
      seedPluginTemplates(db, {
        id: "obs",
        templates: { observerSystem: "DEFAULT-OBS" },
      })
      const row = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "observerSystem"))
        .get()
      expect(row?.body).toBe("DEFAULT-OBS")
      // Edit + re-seed → not overwritten.
      db.update(promptTemplates)
        .set({ body: "EDITED" })
        .where(eq(promptTemplates.key, "observerSystem"))
        .run()
      seedPluginTemplates(db, {
        id: "obs",
        templates: { observerSystem: "DEFAULT-OBS" },
      })
      const row2 = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "observerSystem"))
        .get()
      expect(row2?.body).toBe("EDITED")
    } finally {
      close()
    }
  })
})
