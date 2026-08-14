import type { PromptAttachment } from "@aegisx/shared"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { ModelRef } from "@aegisx/shared/model"

/**
 * Orchestration plugin API (v8 + declarative slots). A Run = one scope
 * (challenge or event) + one orchestration plugin + a shared container + N
 * agents. The plugin DECLARES its agent layout via {@link PluginBase.agents}
 * (slot / role / tools / system-prompt template key / prime); the system
 * materializes those agents and injects each slot's model from the
 * orchestration settings. The plugin only OWNS the event wiring
 * ({@link ChallengePlugin.wire} / {@link EventPlugin.wire}).
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
 * `agent` and `capabilities` are per-agent — filled when the system renders
 * that agent's system prompt (capabilities derived from the agent's tools).
 * Field names match the built-in handlebars templates.
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
   * (id/label/description), so it never invents plugin names. */
  orchestrations?: OrchestrationInfo[]
}

// --- declarative agent slot ------------------------------------------------

/** A plugin's declared agent slot. The system creates one agent per slot
 * (createAgent slot-idempotent) for BOTH create and cold-restore, injecting
 * the slot's model from the orchestration settings. The slot's `tools` may be
 * a static list or a ctx-aware builder (e.g. conditional target tools). */
export type AgentSlotSpec = {
  /** Run-unique createAgent idempotency key. */
  slot: string
  name: string
  /** Default = slot. 'orchestrator' reserved by convention. */
  role?: string
  /** Entry agent (run-level default conversation target); at most one per run. */
  entry?: boolean
  /** Prompt template KEY (e.g. "mainSystem"). Rendered with this agent's
   * per-agent capabilities (spec §3.7). Resolution order at render:
   * current-plugin templates → builtin → throw. */
  systemPrompt: string
  /** Real tool names granted to this agent (file tools always on, not listed).
   * A builder is invoked with the run's PromptContext so tools can be
   * conditional on challenge/target support. */
  tools: string[] | ((ctx: PromptContext) => string[])
  /** true = use `run.initialPrompt` as this agent's first-turn prime (system
   * prepare()+send(prime) on fresh runs; ignored on restore). */
  prime?: boolean
}

/** A slot's resolved model — what the system injects from the orchestration
 * settings at createAgent time. `ref` is persisted on the agent row (snapshot
 * priority on cold-restore); the display fields feed the per-agent prompt
 * context's `model` variable. */
export type SlotModel = {
  /** Canonical model ref string (`<providerKey>/<modelId>:<effort>` | alias). */
  ref: ModelRef
  thinkingLevel: ThinkingLevel
  /** Display: provider label, model label, pi model id (prompt `model` var). */
  providerLabel: string
  modelLabel: string
  modelId: string
}

// --- agent handles (spec §3.2/§3.3) ----------------------------------------

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
  | "run.resumed"

export type EventScopePayload =
  | { type: "run.started"; runId: string; agentId?: string }
  | { type: "run.idle"; runId: string; agentId?: string; failed?: boolean }
  | { type: "run.flagAccepted"; runId: string; agentId?: string }
  | { type: "run.finished"; runId: string; agentId?: string }
  | { type: "run.timedOut"; runId: string; outcome: "idle" | "closed" }
  | { type: "run.resumed"; runId: string; agentId?: string }

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
  /** Scope-aware rendered first-turn prompt. Manual/scheduler enqueue overrides
   * it via queue.prompt (P3); plugins express `prime: run.initialPrompt`. */
  readonly initialPrompt: string
  /** Render a template key against this run's context (current-plugin → builtin
   * → throw). Templates are loaded once into memory at handle construction. */
  render(templateKey: string, extraVars?: Partial<PromptContext>): string
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

type SpawnTemplate = {
  /** Default 'child'. */
  role?: string
  /** Template key; rendered with the parent ctx + { agent: { role, name, task } }
   * and capabilities zeroed. */
  systemPrompt: string
  tools: string[]
}

// --- plugin definition (discriminated union on scope) ---------------------

interface PluginBase {
  id: string
  /** Human-readable name shown in the picker / scheduler catalog. */
  label?: string
  /** One-line description for the picker / scheduler catalog. */
  description?: string
  /** Declared agent layout — the system creates one agent per slot and injects
   * each slot's model from the orchestration settings. */
  agents: AgentSlotSpec[]
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
}

// --- public introspection (GET /api/orchestrations, settings page) ---------

/** A declared slot, as exposed for the settings page / create-run picker. */
type OrchestrationSlotInfo = {
  slot: string
  role: string
  name: string
  entry: boolean
}

/** Full public descriptor of a plugin: its slots + the prompt-template keys it
 * uses (own registered defaults + builtin keys its slots/spawn/initial
 * reference), so the orchestration-settings page can render a model picker per
 * slot and a prompt-editor dialog per template key. */
export type OrchestrationPublic = {
  id: string
  scope: "challenge" | "event"
  label: string
  description: string
  agents: OrchestrationSlotInfo[]
  templates: Record<string, string>
  templateKeys: string[]
}

/** Template keys a plugin references: every slot's system prompt, the spawn
 * template, the always-rendered `initial`, plus its own registered defaults. */
function pluginTemplateKeys(plugin: {
  agents: AgentSlotSpec[]
  spawn?: SpawnTemplate
  templates?: Record<string, string>
}): string[] {
  const keys = new Set<string>(["initial"])
  for (const agent of plugin.agents) keys.add(agent.systemPrompt)
  if (plugin.spawn?.systemPrompt) keys.add(plugin.spawn.systemPrompt)
  if (plugin.templates)
    for (const key of Object.keys(plugin.templates)) keys.add(key)
  return [...keys]
}

/** Project a plugin to its public descriptor. */
export function toOrchestrationPublic(
  plugin: OrchestrationPlugin
): OrchestrationPublic {
  return {
    id: plugin.id,
    scope: plugin.scope,
    label: plugin.label ?? plugin.id,
    description: plugin.description ?? "",
    agents: plugin.agents.map((agent) => ({
      slot: agent.slot,
      role: agent.role ?? agent.slot,
      name: agent.name,
      entry: !!agent.entry,
    })),
    templates: { ...plugin.templates },
    templateKeys: pluginTemplateKeys(plugin),
  }
}

export interface ChallengePlugin extends PluginBase {
  scope: "challenge"
  /** Event wiring only — createAgent is automatic from `agents`. Runs for both
   * create and cold-restore (the plugin cannot tell them apart). */
  wire?(run: RunHandle): void | Promise<void>
}

interface EventPlugin extends PluginBase {
  scope: "event"
  /** Event wiring only; receives the EventHandle for child-run lifecycle. */
  wire?(run: RunHandle, event: EventHandle): void | Promise<void>
}

export type OrchestrationPlugin = ChallengePlugin | EventPlugin

/** Identity helper: registers a plugin literal and narrows its type. The
 * discriminated union on `scope` makes a challenge plugin's `wire(run)` vs an
 * event plugin's `wire(run, event)` a compile-time distinction. */
export function defineOrchestration(
  plugin: OrchestrationPlugin
): OrchestrationPlugin {
  return plugin
}
