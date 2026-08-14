import { describe, expect, test } from "bun:test"

import { eq } from "drizzle-orm"

import { promptTemplates } from "../../src/db/schema"
import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  LEGACY_CHILD_SYSTEM_PROMPT_TEMPLATE,
  LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE,
} from "../../src/orchestration/prompt-defaults"
import {
  BUILTIN_DEFAULTS,
  BUILTIN_PLUGIN,
  loadTemplateMap,
  migrateLegacyPromptSettings,
  renderTemplate,
  seedBuiltinTemplates,
  seedPluginTemplates,
  upgradeBuiltinTemplate,
} from "../../src/orchestration/prompt-templates"
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

  test("upgradeBuiltinTemplate refreshes only rows still equal to the legacy default (W1.3)", () => {
    const { db, close } = setupDb()
    try {
      seedBuiltinTemplates(db)
      // mainSystem: simulate a pre-upgrade DB (row still carries the legacy
      // default body). childSystem: user-edited — must survive untouched.
      db.update(promptTemplates)
        .set({ body: LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE, updatedAt: "x" })
        .where(eq(promptTemplates.key, "mainSystem"))
        .run()
      db.update(promptTemplates)
        .set({ body: "USER-EDITED", updatedAt: "x" })
        .where(eq(promptTemplates.key, "childSystem"))
        .run()

      upgradeBuiltinTemplate(
        db,
        "mainSystem",
        LEGACY_MAIN_SYSTEM_PROMPT_TEMPLATE,
        DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE
      )
      upgradeBuiltinTemplate(
        db,
        "childSystem",
        LEGACY_CHILD_SYSTEM_PROMPT_TEMPLATE,
        DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE
      )

      const main = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "mainSystem"))
        .get()
      expect(main?.body).toBe(DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE)
      const child = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "childSystem"))
        .get()
      expect(child?.body).toBe("USER-EDITED")
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
      const child = db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.key, "childSystem"))
        .get()
      expect(child?.body).toBe(BUILTIN_DEFAULTS.childSystem)
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
