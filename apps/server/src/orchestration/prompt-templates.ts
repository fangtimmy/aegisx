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
  NOTICE_TEMPLATE_DEFAULTS,
} from "./prompt-defaults"

/** Namespace id for the built-in template rows. */
export const BUILTIN_PLUGIN = "builtin"

// --- rendering core (one shared handlebars configuration) --------------------

const handlebars = Handlebars.create()
handlebars.registerHelper("join", (values: unknown, separator: unknown) =>
  Array.isArray(values) ? values.join(String(separator)) : ""
)

/** Render an arbitrary template body with the shared configured handlebars
 * instance (noEscape, strict, `join` helper). Used by {@link renderTemplate}
 * and the preview paths so all rendering goes through one handlebars
 * configuration. The context is loosely typed — orchestration PromptContext is
 * a superset of {@link PromptTemplateContext} (challenge optional,
 * capabilities optional), and the built-in templates only reference fields
 * that the caller has populated. */
export function renderTemplateBody(template: string, context: unknown): string {
  return handlebars
    .compile(template, { noEscape: true, strict: true })(context, {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    })
    .trim()
}

// --- preview segmentation -----------------------------------------------------

export type PromptPreviewSegment = {
  id: number
  text: string
  highlighted: boolean
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

// --- sample contexts (one per context shape) ---------------------------------

export const samplePromptContext: PromptTemplateContext = {
  agent: {
    role: "solver",
    name: "agent-a3f1c2d9",
  },
  event: {
    id: "sample-event",
    name: "Sample CTF",
    platform: "ctfd",
    brief: "flag 格式为 flag{...}；环境完全离线。",
    flagFormats: ["flag{...}"],
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
    confirmedFlags: [],
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

/** Variables available to the scheduler-context templates (orchestratorSystem
 * + schedulerInitial): no challenge/run/agent context — only the owning event
 * and the user's natural-language instruction. */
export type OrchestratorPromptContext = {
  event: { id: string; name: string; brief: string }
  instruction: string
  workspace: { root: string }
}

export const sampleOrchestratorPromptContext: OrchestratorPromptContext = {
  event: {
    id: "sample-event",
    name: "Sample CTF",
    brief: "6 小时评测；KB 命中的题优先快速收割。",
  },
  instruction: "Hit crypto first; leave pwn for last.",
  workspace: { root: "/workspace" },
}

/** Context for the channelDelivery template: the merged delivery block
 * pushed into an agent's turn. */
export type DeliveryRenderContext = {
  /** Delivery-time wall clock (`YYYY-MM-DD HH:MM`, local). */
  now: string
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

const sampleDeliveryContext: DeliveryRenderContext = {
  now: "2026-09-10 14:32",
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

/** Context for the schedulerDigest template: the fleet snapshot appended to
 * every scheduler (orch) delivery. */
export type SchedulerDigestContext = {
  /** Delivery-time wall clock (`YYYY-MM-DD HH:MM`, local). */
  now: string
  /** Time since the event's scheduler started ("" when it never ran). */
  elapsed: string
  /** Time since the newest accepted flag on the whole event ("" when none).
   * The fleet's yield rate in one figure — the stall clock. */
  sinceLastScore: string
  agents: { live: number; max: number }
  targets: { used: number; max: number }
  queue: { pending: number; running: number; paused: boolean }
  /** Board coverage: an untouched challenge is invisible in the per-challenge
   * lines, so its weight is summarised here. */
  board: { total: number; untouched: number; untouchedPoints: number }
  challenges: Array<{
    name: string
    points: number | null
    /** Per-flag value (points / required flags) — the marginal value of the
     * NEXT flag, and the number that makes a chain comparable to a single-flag
     * challenge. */
    perFlag: number | null
    /** Points already earned on this challenge. */
    earned: number | null
    /** Confirmed/total flags (`n/N`); "" for single-flag challenges. */
    flagProgress: string
    /** Pre-derived: 已解 / 部分 / 未解. Only a fully-collected multi-flag
     * chain reads 已解. */
    solvedLabel: string
    /** Time since this challenge's last accepted flag ("" when none). */
    sinceLastFlag: string
    live: number
    running: number
    pending: number
    /** Real dispatch attempts invested (queue-item replays collapsed). */
    attempts: number
    /** Cumulative tokens, compact-formatted ("" when none spent). */
    tokens: string
  }>
}

const sampleSchedulerDigestContext: SchedulerDigestContext = {
  now: "2026-09-10 14:32",
  elapsed: "3h44m",
  sinceLastScore: "1h51m",
  agents: { live: 3, max: 8 },
  targets: { used: 1, max: 2 },
  queue: { pending: 2, running: 1, paused: false },
  board: { total: 63, untouched: 33, untouchedPoints: 12300 },
  challenges: [
    {
      name: "web1",
      points: 300,
      perFlag: 300,
      earned: 0,
      flagProgress: "",
      solvedLabel: "未解",
      sinceLastFlag: "",
      live: 2,
      running: 1,
      pending: 1,
      attempts: 3,
      tokens: "1.2M",
    },
    {
      name: "pwn2",
      points: 1200,
      perFlag: 300,
      earned: 600,
      flagProgress: "2/4",
      solvedLabel: "部分",
      sinceLastFlag: "48m",
      live: 1,
      running: 0,
      pending: 1,
      attempts: 1,
      tokens: "350K",
    },
    {
      name: "crypto1",
      points: 200,
      perFlag: 200,
      earned: 200,
      flagProgress: "",
      solvedLabel: "已解",
      sinceLastFlag: "12m",
      live: 0,
      running: 0,
      pending: 0,
      attempts: 1,
      tokens: "",
    },
  ],
}

/** Sample context for the notice templates (`NOTICE_TEMPLATE_DEFAULTS`,
 * rendered by `run/orch-notices.ts`, `run/agent-status.ts` and the direct
 * scheduler wakes). One context covers every `notice*` key: the shipped
 * defaults reference an `{{#if}}`-guarded subset of the fields below, and a
 * single superset avoids one sample per event kind. Variables, checked
 * against the actual defaults:
 * `challengeName`, `flag`, `submitter`, `stopSiblings` (flagAccepted),
 * `message`, `confirmed` (flagPartial), `progress` (flagPartialProgress),
 * `stopped`, `cancelled` (solveCleanup), `closed`, `cancelled`
 * (challengeHalt), `pending` (queueStarved / eventStalled), `error`
 * (launchFailed), `action`, `manual` (queueStateChanged), `stalled`
 * (eventStalled), `tag`, `failed`, `schedulerActor`, `aborted`
 * (agent lifecycle), `idleAgents` (boot reentry). */
export const sampleNoticeContext = {
  challengeName: "web1",
  flag: "flag{sample}",
  submitter: "agent-a3f1c2d9",
  stopSiblings: false,
  message: "flag 2/3 已确认",
  confirmed: "flag{sample}、flag{sample2}",
  progress: "2/3",
  stopped: 2,
  cancelled: 1,
  closed: 2,
  pending: 1,
  error: "container start failed",
  action: "暂停",
  manual: true,
  stalled: "5m",
  tag: "「web1」agent-a3f1c2d9",
  failed: false,
  schedulerActor: true,
  aborted: false,
  idleAgents: 3,
}

// --- preview entry points ----------------------------------------------------

/** Render a solver system/initial prompt template against the full run
 * context and split the result into highlighted preview segments. Shared by
 * the mainSystemPrompt and initialPrompt preview kinds — both render the same
 * body against the same context shape. */
export function previewPromptTemplate(
  template: string,
  context: PromptTemplateContext = samplePromptContext
) {
  return previewSegments(
    renderTemplateBody(template, markPreviewValues(context))
  )
}

export function previewOrchestratorSystemPrompt(
  template: string,
  context: OrchestratorPromptContext = sampleOrchestratorPromptContext
) {
  return previewSegments(
    renderTemplateBody(template, markPreviewValues(context))
  )
}

function previewChannelDelivery(template: string) {
  return previewSegments(
    renderTemplateBody(template, markPreviewValues(sampleDeliveryContext))
  )
}

function previewSchedulerDigest(template: string) {
  return previewSegments(
    renderTemplateBody(
      template,
      markPreviewValues(sampleSchedulerDigestContext)
    )
  )
}

/** Render an arbitrary notice template body against the sample notice context.
 * Backs the settings preview's single `notice` kind — the frontend sends
 * `kind: "notice"` for every `notice*` template key. */
function previewNotice(template: string) {
  return previewSegments(
    renderTemplateBody(template, markPreviewValues(sampleNoticeContext))
  )
}

// --- template registry -------------------------------------------------------

/** Which context shape a template renders against. `kind` drives the preview
 * sample, the settings-page variable palette grouping, and the generalized
 * drift test; every `notice*` key shares the one notice kind. */
export type PromptTemplateKind =
  | "solver"
  | "orchestrator"
  | "delivery"
  | "digest"
  | "notice"

/** One declaration per built-in template: its key (the `prompt_templates`
 * row), its context kind, the shipped default body, the variable palette the
 * settings editor offers, and the preview renderer. The seeding map, the
 * settings meta, and the preview dispatch all derive from this list — adding
 * a template is one entry here, not five synchronized edits. */
export type PromptTemplateEntry = {
  key: string
  kind: PromptTemplateKind
  default: string
  variables: readonly string[]
  preview(template: string): PromptPreviewSegment[]
}

/** Variable palette for the solver-context templates (mainSystem + initial):
 * the full context a user may interpolate in the editor. */
const SOLVER_PROMPT_VARIABLES = [
  "agent.role",
  "agent.name",
  "event.id",
  "event.name",
  "event.platform",
  "event.brief",
  "event.flagFormats",
  "challenge.id",
  "challenge.name",
  "challenge.description",
  "challenge.category",
  "challenge.points",
  "challenge.attachments",
  "challenge.attachmentPaths",
  "challenge.confirmedFlags",
  "challenge.integrated",
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

export const PROMPT_TEMPLATES: PromptTemplateEntry[] = [
  {
    key: "mainSystem",
    kind: "solver",
    default: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
    variables: SOLVER_PROMPT_VARIABLES,
    preview: (template) => previewPromptTemplate(template),
  },
  {
    key: "initial",
    kind: "solver",
    default: DEFAULT_INITIAL_PROMPT_TEMPLATE,
    variables: SOLVER_PROMPT_VARIABLES,
    preview: (template) => previewPromptTemplate(template),
  },
  {
    key: "orchestratorSystem",
    kind: "orchestrator",
    default: DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
    variables: [
      "event.id",
      "event.name",
      "event.brief",
      "instruction",
      "workspace.root",
    ],
    preview: (template) => previewOrchestratorSystemPrompt(template),
  },
  {
    key: "schedulerInitial",
    kind: "orchestrator",
    default: DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE,
    variables: [
      "event.id",
      "event.name",
      "event.brief",
      "instruction",
      "workspace.root",
    ],
    preview: (template) => previewOrchestratorSystemPrompt(template),
  },
  {
    key: "channelDelivery",
    kind: "delivery",
    default: DEFAULT_CHANNEL_DELIVERY_TEMPLATE,
    variables: [
      "now",
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
    ],
    preview: previewChannelDelivery,
  },
  {
    key: "schedulerDigest",
    kind: "digest",
    default: DEFAULT_SCHEDULER_DIGEST_TEMPLATE,
    variables: [
      "now",
      "elapsed",
      "sinceLastScore",
      "agents.live",
      "agents.max",
      "targets.used",
      "targets.max",
      "queue.pending",
      "queue.running",
      "queue.paused",
      "board.total",
      "board.untouched",
      "board.untouchedPoints",
      "challenges",
      "challenges[].name",
      "challenges[].points",
      "challenges[].perFlag",
      "challenges[].earned",
      "challenges[].flagProgress",
      "challenges[].solvedLabel",
      "challenges[].sinceLastFlag",
      "challenges[].live",
      "challenges[].running",
      "challenges[].pending",
      "challenges[].attempts",
      "challenges[].tokens",
    ],
    preview: previewSchedulerDigest,
  },
  ...Object.entries(NOTICE_TEMPLATE_DEFAULTS).map(([key, body]) => ({
    key,
    kind: "notice" as const,
    default: body,
    variables: Object.keys(sampleNoticeContext),
    preview: previewNotice,
  })),
]

/** The built-in template keys + their default bodies. Seeded into
 * prompt_templates (plugin='builtin') at app boot. Derived from
 * {@link PROMPT_TEMPLATES} — the registry is the single declaration. */
export const BUILTIN_DEFAULTS: Record<string, string> = Object.fromEntries(
  PROMPT_TEMPLATES.map((entry) => [entry.key, entry.default])
)

function paletteOf(kind: PromptTemplateKind): string[] {
  const palette = new Set<string>()
  for (const entry of PROMPT_TEMPLATES) {
    if (entry.kind === kind) {
      for (const variable of entry.variables) palette.add(variable)
    }
  }
  return [...palette]
}

/** Settings-meta variable palettes, grouped by context kind. Derived from the
 * registry so a new template's variables show up in the editor without a
 * separate list edit. */
export const PROMPT_TEMPLATE_VARIABLES = paletteOf("solver")
export const ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES = paletteOf("orchestrator")
export const DELIVERY_TEMPLATE_VARIABLES = paletteOf("delivery")
export const SCHEDULER_DIGEST_TEMPLATE_VARIABLES = paletteOf("digest")
export const NOTICE_TEMPLATE_VARIABLES = paletteOf("notice")

/**
 * Seed the built-in prompt template rows. Idempotent: inserts defaults
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
