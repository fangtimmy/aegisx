import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
} from "@aegisx/shared/prompt-defaults"
import { and, eq, inArray } from "drizzle-orm"

import type { createDatabase } from "../db"
import { promptTemplates } from "../db/schema"
import { renderTemplateBody } from "../settings/prompt-templates"

type Database = ReturnType<typeof createDatabase>["db"]

/** plugin id for the four built-in templates. */
export const BUILTIN_PLUGIN = "builtin"

/** The four built-in template keys + their default bodies. Seeded into
 * prompt_templates (plugin='builtin') at app boot. */
export const BUILTIN_DEFAULTS: Record<string, string> = {
  mainSystem: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  childSystem: DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  initial: DEFAULT_INITIAL_PROMPT_TEMPLATE,
  orchestratorSystem: DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
}

/**
 * Seed the four built-in prompt template rows. Idempotent: inserts defaults
 * only where no row exists (ON CONFLICT DO NOTHING via unique(plugin,key)), so
 * a user's edit (an UPDATE) always survives reboots. Called once at app boot,
 * before any RunHandle is built (spec §3.6).
 */
export function seedBuiltinTemplates(db: Database): void {
  const now = new Date().toISOString()
  for (const [key, body] of Object.entries(BUILTIN_DEFAULTS)) {
    db.insert(promptTemplates)
      .values({ plugin: BUILTIN_PLUGIN, key, body, updatedAt: now })
      .onConflictDoNothing()
      .run()
  }
}

/** One-time refresh of built-in template rows that still hold a known prior
 * default body. A row is updated only if its current body exactly equals the
 * `fromBody` (i.e. the user has not customized it), so user edits always
 * survive. Used to ship prompt improvements (e.g. the scheduler catalog) to
 * existing databases without a schema bump. */
export function upgradeBuiltinTemplate(
  db: Database,
  key: string,
  fromBody: string,
  toBody: string
): void {
  if (fromBody === toBody) return
  const row = db
    .select({ body: promptTemplates.body })
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.plugin, BUILTIN_PLUGIN),
        eq(promptTemplates.key, key)
      )
    )
    .get()
  if (!row || row.body !== fromBody) return // absent (seeded fresh) or customized
  db.update(promptTemplates)
    .set({ body: toBody, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(promptTemplates.plugin, BUILTIN_PLUGIN),
        eq(promptTemplates.key, key)
      )
    )
    .run()
}

/**
 * Seed a plugin's declared default templates (spec §3.6: upsert at registration
 * only when no user edit exists for (plugin,key)). Idempotent via ON CONFLICT
 * DO NOTHING. Plugins without `templates` (e.g. classic, which uses only the
 * built-ins) are a no-op.
 */
export function seedPluginTemplates(
  db: Database,
  plugin: { id: string; templates?: Record<string, string> }
): void {
  if (!plugin.templates) return
  const now = new Date().toISOString()
  for (const [key, body] of Object.entries(plugin.templates)) {
    db.insert(promptTemplates)
      .values({ plugin: plugin.id, key, body, updatedAt: now })
      .onConflictDoNothing()
      .run()
  }
}

/**
 * Carry pre-v8 FlatSettings prompt edits into the prompt_templates store
 * (spec §3.6/§14.1). A legacy value is written only when it differs from the
 * builtin default AND the current row is still the seed default — edits made
 * directly in the table during v8 win over legacy config. Idempotent.
 */
export function migrateLegacyPromptSettings(
  db: Database,
  legacy: Readonly<Record<string, string>> | undefined
): void {
  if (!legacy) return
  const now = new Date().toISOString()
  for (const [key, body] of Object.entries(legacy)) {
    if (!(key in BUILTIN_DEFAULTS)) continue
    if (body === BUILTIN_DEFAULTS[key]) continue // untouched → nothing to migrate
    const row = db
      .select({ body: promptTemplates.body })
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.plugin, BUILTIN_PLUGIN),
          eq(promptTemplates.key, key)
        )
      )
      .get()
    if (!row || row.body !== BUILTIN_DEFAULTS[key]) continue // already customized
    db.update(promptTemplates)
      .set({ body, updatedAt: now })
      .where(
        and(
          eq(promptTemplates.plugin, BUILTIN_PLUGIN),
          eq(promptTemplates.key, key)
        )
      )
      .run()
  }
}

/**
 * Load this run's in-memory template map: the plugin's own templates overlaid
 * on the built-in defaults (same key → plugin wins, spec §3.6 resolution order).
 * Returned as a Map so {@link renderTemplate} never hits the DB — a RunHandle
 * loads it once at construction and renders only against that snapshot (no
 * cross-run cache → edits take effect on the next run, no stale reads).
 */
export function loadTemplateMap(
  db: Database,
  pluginId: string
): Map<string, string> {
  const rows = db
    .select()
    .from(promptTemplates)
    .where(inArray(promptTemplates.plugin, [BUILTIN_PLUGIN, pluginId]))
    .all()
  const map = new Map<string, string>()
  // Built-ins first, then the plugin's own keys override (same key → plugin).
  for (const row of rows) {
    if (row.plugin === BUILTIN_PLUGIN) map.set(row.key, row.body)
  }
  for (const row of rows) {
    if (row.plugin === pluginId) map.set(row.key, row.body)
  }
  return map
}

/**
 * Render a template key from an in-memory map. Resolution is just a Map lookup
 * (the map already encodes plugin → builtin precedence). Throws if the key is
 * absent. An empty body renders to an empty string (no fallback) — user edits
 * to "" are honored (spec §3.6 empty-string semantics).
 */
export function renderTemplate(
  map: Map<string, string>,
  key: string,
  context: unknown
): string {
  const body = map.get(key)
  if (body === undefined) {
    throw new Error(`Prompt template not found: ${key}`)
  }
  return renderTemplateBody(body, context)
}
