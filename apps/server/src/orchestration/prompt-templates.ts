import type { PromptTemplateContext } from "@aegisx/shared"
import { and, eq, inArray } from "drizzle-orm"
import Handlebars from "handlebars"

import type { Database } from "../db"
import { promptTemplates } from "../db/schema"
import {
  DEFAULT_CHILD_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
} from "./prompt-defaults"

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
 * before any RunHandle is built.
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
 * Seed a plugin's declared default templates (upsert at registration only when
 * no user edit exists for (plugin,key)). Idempotent via ON CONFLICT DO
 * NOTHING. Plugins without `templates` (e.g. classic, which uses only the
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
 * Carry pre-v8 FlatSettings prompt edits into the prompt_templates store. A
 * legacy value is written only when it differs from the builtin default AND
 * the current row is still the seed default — edits made directly in the table
 * during v8 win over legacy config. Idempotent.
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
 * on the built-in defaults (same key → plugin wins, the resolution order).
 * Returned as a Map so render never hits the DB — a RunHandle loads it once at
 * construction and renders only against that snapshot (no cross-run cache →
 * edits take effect on the next run, no stale reads).
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
 * to "" are honored (empty-string semantics).
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

export const PROMPT_TEMPLATE_VARIABLES = [
  "agent.role",
  "agent.isMain",
  "agent.name",
  "agent.task",
  "event.id",
  "event.name",
  "event.platform",
  "challenge.id",
  "challenge.name",
  "challenge.description",
  "challenge.category",
  "challenge.points",
  "challenge.attachments",
  "challenge.attachmentPaths",
  "model.provider",
  "model.name",
  "model.id",
  "run.id",
  "run.environment",
  "run.isContainer",
  "run.workspace",
  "run.targetSupported",
  "run.platformIntegrated",
  "run.containerImage",
  "run.cpus",
  "run.memoryMb",
  "run.pidsLimit",
  "capabilities.canFinish",
  "capabilities.canSpawn",
  "capabilities.canSubmitFlag",
  "capabilities.canManageTarget",
] as const

export type PromptPreviewSegment = {
  id: number
  text: string
  highlighted: boolean
}

const handlebars = Handlebars.create()
handlebars.registerHelper("join", (values: unknown, separator: unknown) =>
  Array.isArray(values) ? values.join(String(separator)) : ""
)

export const samplePromptContext: PromptTemplateContext = {
  agent: {
    role: "main",
    isMain: true,
    name: "Main agent",
    task: null,
  },
  event: {
    id: "sample-event",
    name: "Sample CTF",
    platform: "ctfd",
    promptHint: "",
  },
  challenge: {
    id: "sample-challenge",
    name: "Encrypted Notes",
    description: "Recover the flag from the provided application.",
    category: "web",
    points: 300,
    attachments: [
      { name: "challenge.zip", path: "challenge.zip", size: 12_345 },
    ],
    attachmentPaths: ["challenge.zip"],
  },
  model: {
    provider: "Sample Provider",
    name: "Sample Model",
    id: "sample-model",
  },
  run: {
    id: "sample-run",
    environment: "container",
    isContainer: true,
    workspace: "/workspace",
    targetSupported: true,
    platformIntegrated: true,
    containerImage: "aegisx/solve:latest",
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 256,
  },
  capabilities: {
    canFinish: true,
    canSpawn: true,
    canSubmitFlag: true,
    canManageTarget: true,
  },
}

function render(template: string, context: PromptTemplateContext) {
  return handlebars
    .compile(template, { noEscape: true, strict: true })(context, {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    })
    .trim()
}

/** Render an arbitrary template body with the shared configured handlebars
 * instance (noEscape, strict, `join` helper). Used by {@link renderTemplate}
 * and the preview paths so all rendering goes through one handlebars
 * configuration. The context is loosely typed — orchestration PromptContext is
 * a superset of the legacy {@link PromptTemplateContext} shape (challenge
 * optional, capabilities optional), and the built-in templates only reference
 * fields that the caller has populated. */
export function renderTemplateBody(template: string, context: unknown): string {
  return render(template, context as PromptTemplateContext)
}

const HIGHLIGHT_START = "\uE000"
const HIGHLIGHT_END = "\uE001"

function markPreviewValues(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number") {
    return `${HIGHLIGHT_START}${value}${HIGHLIGHT_END}`
  }
  if (Array.isArray(value)) return value.map(markPreviewValues)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, markPreviewValues(item)])
    )
  }
  return value
}

function previewSegments(value: string): PromptPreviewSegment[] {
  const segments: PromptPreviewSegment[] = []
  let offset = 0
  while (offset < value.length) {
    const start = value.indexOf(HIGHLIGHT_START, offset)
    if (start === -1) {
      segments.push({
        id: segments.length,
        text: value.slice(offset),
        highlighted: false,
      })
      break
    }
    if (start > offset) {
      segments.push({
        id: segments.length,
        text: value.slice(offset, start),
        highlighted: false,
      })
    }
    const end = value.indexOf(HIGHLIGHT_END, start + 1)
    if (end === -1) {
      segments.push({
        id: segments.length,
        text: value.slice(start + 1),
        highlighted: true,
      })
      break
    }
    segments.push({
      id: segments.length,
      text: value.slice(start + 1, end),
      highlighted: true,
    })
    offset = end + 1
  }
  return segments
    .flatMap((segment) => {
      if (segment.highlighted) return [segment]
      return segment.text
        .split(/(\b(?:true|false)\b)/)
        .filter(Boolean)
        .map((text) => ({
          ...segment,
          text,
          highlighted: text === "true" || text === "false",
        }))
    })
    .map((segment, id) => ({ ...segment, id }))
}

/** Render a system/initial prompt body against the full run context. */
export function renderSystemPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return render(template, context)
}

/** Variables available to the orchestrator system-prompt template. The
 * orchestrator has no challenge/run/agent context — only the owning event and
 * the user's natural-language instruction. */
export const ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES = [
  "event.id",
  "event.name",
  "instruction",
] as const

export type OrchestratorPromptContext = {
  event: { id: string; name: string }
  instruction: string
}

export const sampleOrchestratorPromptContext: OrchestratorPromptContext = {
  event: { id: "sample-event", name: "Sample CTF" },
  instruction: "Hit crypto first; leave pwn for last.",
}

export function previewSystemPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return previewSegments(
    renderSystemPrompt(
      template,
      markPreviewValues(context) as PromptTemplateContext
    )
  )
}

export function previewOrchestratorSystemPrompt(
  template: string,
  context: OrchestratorPromptContext
) {
  return previewSegments(
    renderTemplateBody(template, markPreviewValues(context))
  )
}

export function previewInitialPrompt(
  template: string,
  context: PromptTemplateContext
) {
  return previewSegments(
    renderSystemPrompt(
      template,
      markPreviewValues(context) as PromptTemplateContext
    )
  )
}
