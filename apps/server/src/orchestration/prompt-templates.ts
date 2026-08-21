import type { PromptTemplateContext } from "@aegisx/shared"
import { eq } from "drizzle-orm"
import Handlebars from "handlebars"

import type { Database } from "../db"
import { promptTemplates } from "../db/schema"
import {
  DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_SCHEDULER_DIGEST_TEMPLATE,
  DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE,
} from "./prompt-defaults"

/** Namespace id for the built-in template rows. */
export const BUILTIN_PLUGIN = "builtin"

/** The built-in template keys + their default bodies. Seeded into
 * prompt_templates (plugin='builtin') at app boot. */
export const BUILTIN_DEFAULTS: Record<string, string> = {
  mainSystem: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  initial: DEFAULT_INITIAL_PROMPT_TEMPLATE,
  orchestratorSystem: DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  schedulerInitial: DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE,
  channelDelivery: DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
  schedulerDigest: DEFAULT_SCHEDULER_DIGEST_TEMPLATE,
}

/**
 * Seed the four built-in prompt template rows. Idempotent: inserts defaults
 * only where no row exists (ON CONFLICT DO NOTHING via unique(plugin,key)), so
 * a user's edit (an UPDATE) always survives reboots. Called once at app boot,
 * before any agent is created.
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
/**
 * Load the in-memory builtin template map (plugin='builtin' only — v9 has no
 * plugin templates). Returned as a Map so render never hits the DB — the run
 * factory loads it once at agent-creation time and renders only against that
 * snapshot (no cross-run cache → edits take effect on the next run, no stale
 * reads).
 */
export function loadTemplateMap(db: Database): Map<string, string> {
  const rows = db
    .select()
    .from(promptTemplates)
    .where(eq(promptTemplates.plugin, BUILTIN_PLUGIN))
    .all()
  const map = new Map<string, string>()
  for (const row of rows) map.set(row.key, row.body)
  return map
}

/**
 * Render a template key from an in-memory map. Resolution is just a Map lookup
 * (the map holds only builtin rows). Throws if the key is absent. An empty body renders to an empty string (no fallback) — user edits
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
  "agent.name",
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
  "workspace.root",
  "workspace.agentDir",
  "workspace.sharedDir",
  "workspace.attachmentsDir",
  "workspace.siblingsDir",
  "workspace.containerImage",
  "workspace.cpus",
  "workspace.memoryMb",
  "workspace.pidsLimit",
  "capabilities.canFinish",
  "capabilities.canSubmitFlag",
  "capabilities.canManageTarget",
  "strategy",
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
    role: "solver",
    name: "agent-a3f1c2d9",
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
    integrated: true,
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
  workspace: {
    root: "/workspace",
    agentDir: "agents/a3f1c2d9",
    sharedDir: "shared",
    attachmentsDir: "attachments",
    siblingsDir: "agents",
    containerImage: "aegisx/solve:latest",
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 256,
  },
  capabilities: {
    canFinish: true,
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

// --- delivery templates (channelDelivery / schedulerDigest) -----------------

/** Context for the channelDelivery template: the merged delivery block
 * pushed into an agent's turn. */
export type DeliveryRenderContext = {
  dropped: number
  messages: Array<{
    urgent: boolean
    label: string
    authorName: string
    /** Pre-formatted HH:MM. */
    time: string
    /** Pre-trimmed body (empty → "(空)"). */
    body: string
    files: Array<{ filename: string; size: string; path: string }>
  }>
}

export const DELIVERY_TEMPLATE_VARIABLES = [
  "dropped",
  "messages",
  "messages[].urgent",
  "messages[].label",
  "messages[].authorName",
  "messages[].time",
  "messages[].body",
  "messages[].files",
  "messages[].files[].filename",
  "messages[].files[].size",
  "messages[].files[].path",
] as const

const sampleDeliveryContext: DeliveryRenderContext = {
  dropped: 0,
  messages: [
    {
      urgent: false,
      label: "#team",
      authorName: "agent-a3f1c2d9",
      time: "14:32",
      body: "SQL 注入点已确认：/api/search 的 id 参数，可首注。",
      files: [],
    },
    {
      urgent: true,
      label: "#orch",
      authorName: "Scheduler",
      time: "14:35",
      body: "target expires in 3min — extend or drop?",
      files: [
        {
          filename: "exp2.py",
          size: "1.2KB",
          path: "shared/from-a3f1c2d9/exp2.py",
        },
      ],
    },
  ],
}

export function previewChannelDelivery(template: string) {
  return previewSegments(
    renderTemplateBody(template, markPreviewValues(sampleDeliveryContext))
  )
}

/** Context for the schedulerDigest template: the fleet snapshot appended to
 * every scheduler (orch) delivery. */
export type SchedulerDigestContext = {
  agents: { live: number; max: number }
  targets: { used: number; max: number }
  queue: { pending: number; running: number; paused: boolean }
  challenges: Array<{
    name: string
    points: number | null
    /** Pre-derived: 已解 / 部分 / 未解. */
    solvedLabel: string
    live: number
    running: number
    pending: number
  }>
}

export const SCHEDULER_DIGEST_TEMPLATE_VARIABLES = [
  "agents.live",
  "agents.max",
  "targets.used",
  "targets.max",
  "queue.pending",
  "queue.running",
  "queue.paused",
  "challenges",
  "challenges[].name",
  "challenges[].points",
  "challenges[].solvedLabel",
  "challenges[].live",
  "challenges[].running",
  "challenges[].pending",
] as const

const sampleSchedulerDigestContext: SchedulerDigestContext = {
  agents: { live: 3, max: 8 },
  targets: { used: 1, max: 2 },
  queue: { pending: 2, running: 1, paused: false },
  challenges: [
    {
      name: "web1",
      points: 300,
      solvedLabel: "未解",
      live: 2,
      running: 1,
      pending: 1,
    },
    {
      name: "pwn2",
      points: 500,
      solvedLabel: "部分",
      live: 1,
      running: 0,
      pending: 1,
    },
    {
      name: "crypto1",
      points: 200,
      solvedLabel: "已解",
      live: 0,
      running: 0,
      pending: 0,
    },
  ],
}

export function previewSchedulerDigest(template: string) {
  return previewSegments(
    renderTemplateBody(
      template,
      markPreviewValues(sampleSchedulerDigestContext)
    )
  )
}
