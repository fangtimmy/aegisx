import type { PromptAttachment } from "@aegisx/shared"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import { Type, type TSchema } from "typebox"

import { ThinkingLevelSchema } from "../lib/schemas"

/**
 * Orchestration plugin API (v8). A Run = one scope (challenge or event) + one
 * orchestration plugin + a shared container + N agents. The plugin owns the
 * agent layout: a single {@link OrchestrationPlugin.setup} runs for BOTH
 * create and cold-restore (the plugin cannot tell them apart), declaring agents
 * via {@link RunHandle.createAgent} and wiring triggers via {@link RunHandle.on}.
 * First-turn startup is expressed declaratively via {@link AgentSpec.prime}
 * (the system auto prepare()+send(prime) on fresh runs; restore ignores it).
 *
 * See `docs/orchestration-redesign.md` §三 (plugin API), §四 (lifecycle).
 */

// --- per-agent capabilities (derived from the agent's tool list) -----------

/** Per-agent capability flags. Derived from the agent's `tools` array
 * (spec §3.7), NOT from the run/challenge — so each agent's rendered system
 * prompt advertises exactly the abilities its tool set grants. */
export type Capabilities = {
  canFinish: boolean
  canSubmitFlag: boolean
  canManageTarget: boolean
  canSpawn: boolean
}

/** Derive per-agent capabilities from a tool-name list (spec §3.7):
 *  - canFinish       = has `finish_run`
 *  - canSubmitFlag   = has `submit_flag`
 *  - canManageTarget = has any `*_target`
 *  - canSpawn        = has `spawn_agent`
 * File tools (read/bash/edit/write) are always on and never listed, so they
 * contribute nothing here. */
export function deriveCapabilities(tools: string[]): Capabilities {
  return {
    canFinish: tools.includes("finish_run"),
    canSubmitFlag: tools.includes("submit_flag"),
    canManageTarget: tools.some((name) => name.endsWith("_target")),
    canSpawn: tools.includes("spawn_agent"),
  }
}

// --- unified, scope-aware prompt render context (spec §3.7) ---------------

/**
 * Unified render context. Scope-aware: `challenge` is present only for
 * challenge-scoped runs; `instruction` only for event-scoped (scheduler) runs.
 * `agent` and `capabilities` are per-agent — filled by {@link RunHandle.createAgent}
 * when rendering that agent's system prompt (capabilities derived from the
 * agent's tools). Field names match the built-in handlebars templates
 * (`canFinish`/`canSpawn` per spec §3.7).
 */
export type PromptContext = {
  event: {
    id: string
    name: string
    platform: string | null
    promptHint: string
  }
  challenge?: {
    id: string
    name: string
    description: string
    category: string | null
    points: number | null
    attachments: PromptAttachment[]
    attachmentPaths: string[]
  }
  agent?: {
    role: string
    isMain: boolean
    name: string
    task: string | null
    isEntry?: boolean
  }
  model?: {
    provider: string
    name: string
    id: string
  }
  run?: {
    id: string
    environment: "container"
    isContainer: true
    workspace: string
    targetSupported: boolean
    platformIntegrated: boolean
    containerImage: string
    cpus: number
    memoryMb: number
    pidsLimit: number
  }
  capabilities?: Capabilities
  /** event-scoped only (scheduler instruction). */
  instruction?: string
  /** event-scoped only: the challenge orchestrations the scheduler may launch
   * (id/label/description/needsModels), so it never invents plugin names. */
  orchestrations?: OrchestrationInfo[]
}

// --- model reference ------------------------------------------------------

/** Typebox schema for a per-agent model reference (plugin `params` declare
 * models with this; `AgentSpec.model` accepts ModelRef literals). */
export const ModelRefSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
    thinking: ThinkingLevelSchema,
  },
  { additionalProperties: false }
)

export type ModelRef = {
  provider: string
  modelId: string
  thinking: ThinkingLevel
}

/** A persisted model snapshot (the run default or a per-agent override). */
export type ModelSnapshot = {
  provider: string
  providerLabel: string | null
  modelId: string
  modelLabel: string | null
  thinkingLevel: ThinkingLevel
}

// --- agent spec + handles (spec §3.2/§3.3) --------------------------------

export type AgentSpec = {
  /** Run-unique createAgent idempotency key. */
  slot: string
  name: string
  /** Default = slot. 'orchestrator' reserved by convention. */
  role?: string
  /** Prompt template KEY (e.g. "mainSystem"). createAgent renders it with this
   * agent's per-agent capabilities (spec §3.7). Resolution order at render:
   * current-plugin templates → builtin → throw. */
  systemPrompt: string
  /** Real tool names granted to this agent (file tools always on, not listed). */
  tools: string[]
  /** 'default' = the run's default model (snapshot at createAgent). */
  model: "default" | ModelRef
  /** First-turn startup text; the system prepare()+send(prime) on fresh runs.
   * Ignored on restore. */
  prime?: string
  /** Entry agent (run-level default conversation target); at most one per run. */
  entry?: boolean
}

export type AgentEvent =
  | "turnEnded"
  | "flagAccepted"
  | "timedOut"
  | "spawned"
  | "finishing"

export type AgentEventPayload =
  | { type: "turnEnded"; error?: string }
  | { type: "flagAccepted"; flag: string; status: string }
  | { type: "timedOut"; outcome: "idle" | "closed" }
  | { type: "spawned"; childAgentId: string }
  | { type: "finishing"; summary: string }

export type EventScopeEvent =
  | "run.started"
  | "run.idle"
  | "run.flagAccepted"
  | "run.finished"
  | "run.timedOut"

export type EventScopePayload =
  | { type: "run.started"; runId: string; agentId?: string }
  | { type: "run.idle"; runId: string; agentId?: string }
  | { type: "run.flagAccepted"; runId: string; agentId?: string }
  | { type: "run.finished"; runId: string; agentId?: string }
  | { type: "run.timedOut"; runId: string; outcome: "idle" | "closed" }

export interface AgentHandle {
  readonly id: string
  readonly slot: string
  readonly role: string
  readonly isStreaming: boolean
  /** Prepare the environment: container online + this agent's session online
   * (first time = create, restore = open). Idempotent; sends nothing. */
  prepare(): Promise<void>
  /** Deliver a message: steer/followUp while streaming, else a fresh turn
   * (auto-prepares). */
  send(text: string, deliverAs?: "steer" | "followUp"): Promise<void>
  /** Abort the current turn (settles to idle; run status is SQL-derived). */
  abort(): Promise<void>
  /** Subscribe to this agent's events. Returns an unsubscribe. */
  on(
    event: AgentEvent,
    cb: (e: AgentEventPayload) => void | Promise<void>
  ): () => void
}

export interface RunHandle<P = any> {
  readonly id: string
  readonly scope: "challenge" | "event"
  readonly ctx: PromptContext
  readonly params: P
  /** Scope-aware rendered first-turn prompt. Manual/scheduler enqueue overrides
   * it via queue.prompt (P3); plugins express `prime: run.initialPrompt`. */
  readonly initialPrompt: string
  /** Render a template key against this run's context (current-plugin → builtin
   * → throw). Templates are loaded once into memory at handle construction. */
  render(templateKey: string, extraVars?: Partial<PromptContext>): string
  /** Declare an agent (slot idempotent): first time persists the row with a
   * systemPrompt/tools/model snapshot; restore reuses the existing row with
   * snapshot priority. Does NOT create a session — prepare() materializes it. */
  createAgent(spec: AgentSpec): AgentHandle
  agent(slot: string): AgentHandle
  readonly agents: AgentHandle[]
  /** Subscribe to ANY agent's events in this run. Returns an unsubscribe. */
  on(
    event: AgentEvent,
    cb: (e: AgentEventPayload) => void | Promise<void>
  ): () => void
}

export interface EventHandle {
  /** Subscribe to a run lifecycle event; the callback's payload is narrowed to
   * the event's own shape (spec §3.4). */
  on<E extends EventScopeEvent>(
    event: E,
    cb: (e: Extract<EventScopePayload, { type: E }>) => void | Promise<void>
  ): () => void
}

// --- spawn template -------------------------------------------------------

export type SpawnTemplate = {
  /** Default 'child'. */
  role?: string
  /** Template key; rendered with the parent ctx + { agent: { role, name, task } }
   * and capabilities zeroed (P2 refines; P1c routes via builtin childSystem). */
  systemPrompt: string
  tools: string[]
  model: "default" | ModelRef
}

// --- plugin definition (discriminated union on scope) ---------------------

interface PluginBase {
  id: string
  /** Human-readable name shown in the picker / scheduler catalog. */
  label?: string
  /** One-line description for the picker / scheduler catalog. */
  description?: string
  /** Input declaration (typebox); UI/enqueue render against it. */
  params: TSchema
  /** Default template bodies, upserted at registration (only when no user edit
   * exists for (plugin,key)). */
  templates?: Record<string, string>
  /** spawn_agent derived template; omitted = default (file tools only, 'child'). */
  spawn?: SpawnTemplate
}

/** Compact orchestration descriptor for the scheduler's prompt catalog. */
export type OrchestrationInfo = {
  id: string
  label: string
  description: string
  /** Whether the plugin's params include model refs (so the scheduler knows
   * it must not invent params — omit them to use defaults). */
  needsModels: boolean
}

/** Whether a plugin's params schema contains any model-ref ({provider,modelId}).
 * Pure schema walk — shared by the scheduler catalog and the run-create form. */
export function pluginNeedsModels(params: TSchema): boolean {
  const isModelRef = (node: TSchema): boolean => {
    if (!node || typeof node !== "object") return false
    const props = (node as { properties?: Record<string, unknown> }).properties
    return (
      !!props &&
      typeof props.provider === "object" &&
      typeof props.modelId === "object"
    )
  }
  const walk = (node: TSchema): boolean => {
    if (!node || typeof node !== "object") return false
    const n = node as {
      type?: string
      properties?: Record<string, TSchema>
      items?: TSchema
    }
    if (n.type === "object" && n.properties) {
      if (isModelRef(node as TSchema)) return true
      return Object.values(n.properties).some(walk)
    }
    if (n.type === "array" && n.items) {
      const items = n.items
      const arr = node as { minItems?: number; maxItems?: number }
      const count =
        arr.maxItems !== undefined &&
        arr.minItems !== undefined &&
        arr.maxItems === arr.minItems
          ? arr.maxItems
          : (arr.minItems ?? 1)
      return count > 0 && walk(items)
    }
    return false
  }
  return walk(params)
}

export interface ChallengePlugin<P = any> extends PluginBase {
  scope: "challenge"
  setup(run: RunHandle<P>): void | Promise<void>
}

export interface EventPlugin<P = any> extends PluginBase {
  scope: "event"
  setup(run: RunHandle<P>, event: EventHandle): void | Promise<void>
}

export type OrchestrationPlugin<P = any> = ChallengePlugin<P> | EventPlugin<P>

/** Identity helper: registers a plugin literal and narrows its type. The
 * discriminated union on `scope` makes a challenge plugin's `setup(run)` vs an
 * event plugin's `setup(run, event)` a compile-time distinction. */
export function defineOrchestration<P>(
  plugin: OrchestrationPlugin<P>
): OrchestrationPlugin<P> {
  return plugin
}
