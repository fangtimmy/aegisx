import type { ModelRef } from "@aegisx/shared/model-ref"

import type { agents } from "../db/schema"
import { renderTemplate } from "./prompt-templates-store"
import type {
  AgentEvent,
  AgentEventPayload,
  AgentHandle,
  AgentSlotSpec,
  Capabilities,
  EventScopeEvent,
  EventScopePayload,
  PromptContext,
  RunHandle,
  SlotModel,
} from "./types"
import { deriveCapabilities } from "./types"

type AgentRow = typeof agents.$inferSelect

/** Fields the handle asks the service to persist for a freshly declared agent.
 * The rendered system prompt, the tool list, and the model ref are all written
 * once here and reused verbatim on cold-restore (snapshot priority, spec §4.3). */
export type FreshAgentInput = {
  slot: string
  role: string
  name: string
  isEntry: boolean
  parentAgentId?: string | null
  task?: string | null
  systemPrompt: string
  tools: string[]
  /** Canonical model ref string, persisted on the agent row. */
  model: ModelRef
}

/**
 * Service callbacks the handle delegates to. The handle is a thin plugin-
 * facing facade; the service owns the DB, the per-agent locks/lifecycle, the
 * container, and the emitter. All callbacks are keyed by agentId (per-agent,
 * spec §4.5a) — no run-level locking leaks through.
 */
export type RunHandleHost = {
  runId: string
  scope: "challenge" | "event"
  ctx: PromptContext
  initialPrompt: string
  templateMap: Map<string, string>
  emitter: RunEmitter
  /** The plugin's declared agent slots — the handle creates one agent each. */
  agents: AgentSlotSpec[]

  /** Existing agent row for a slot (createAgent idempotency / restore reuse). */
  findAgentBySlot(slot: string): AgentRow | undefined
  /** Persist a freshly declared agent; returns its new id. */
  createFreshAgent(input: FreshAgentInput): string
  /** Resolve a slot's model from the orchestration settings (fresh create
   * only; restore reuses the persisted snapshot). Throws if unresolvable. */
  resolveSlotModel(slot: string): SlotModel
  /** Whether the agent currently has an in-flight turn. */
  isAgentStreaming(agentId: string): boolean
  /** Ensure the container + this agent's session are online (create or open). */
  prepareAgent(runId: string, agentId: string): Promise<void>
  /** Deliver a message (steer/followUp while streaming, else a fresh turn). */
  sendToAgent(
    agentId: string,
    text: string,
    deliverAs?: "steer" | "followUp"
  ): Promise<void>
  /** Abort the agent's current turn. */
  abortAgent(agentId: string): Promise<void>
}

/**
 * Per-run event emitter (spec §3.5). Plugin `on` callbacks fire here, wrapped
 * in try/catch so a throwing callback never escapes (log + swallow). Callbacks
 * are expected to be cheap and side-effect-free except for `send()`; the
 * service emits from the generation-gated settle critical section.
 *
 * send() inside a callback can be rejected by the fresh-turn capacity gate
 * (spec §8.2): the RunActionError propagates to THIS try/catch, is logged and
 * swallowed, and the callback's remaining work is skipped — a dropped observer
 * wake-up is an accepted degradation under capacity pressure (the observer can
 * be re-woken by its own next turn or a manual message).
 */
export class RunEmitter {
  private readonly runLevel = new Map<
    AgentEvent,
    Set<(e: AgentEventPayload) => void>
  >()
  private readonly perAgent = new Map<
    string,
    Map<AgentEvent, Set<(e: AgentEventPayload) => void>>
  >()

  /** Subscribe to a specific agent's events. */
  onAgent(
    agentId: string,
    event: AgentEvent,
    cb: (e: AgentEventPayload) => void
  ): () => void {
    let byEvent = this.perAgent.get(agentId)
    if (!byEvent) {
      byEvent = new Map()
      this.perAgent.set(agentId, byEvent)
    }
    let set = byEvent.get(event)
    if (!set) {
      set = new Set()
      byEvent.set(event, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  /** Subscribe to ANY agent's events in this run (run-level). */
  onRun(event: AgentEvent, cb: (e: AgentEventPayload) => void): () => void {
    let set = this.runLevel.get(event)
    if (!set) {
      set = new Set()
      this.runLevel.set(event, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  /** Dispatch a payload to the agent-specific + run-level subscribers. */
  emit(agentId: string, payload: AgentEventPayload): void {
    const dispatch = (set: Set<(e: AgentEventPayload) => void> | undefined) => {
      if (!set) return
      for (const cb of set) {
        try {
          cb(payload)
        } catch (error) {
          console.error("orchestration on() callback threw", {
            agentId,
            event: payload.type,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    dispatch(this.runLevel.get(payload.type))
    dispatch(this.perAgent.get(agentId)?.get(payload.type))
  }

  /** Drop every subscriber (close clears the emitter; resume rebuilds). */
  close(): void {
    this.runLevel.clear()
    this.perAgent.clear()
  }
}

/**
 * Per-event emitter for run lifecycle events (spec §3.5 EventHandle). One per
 * event, owned by the scheduler (event-scoped) run; child-run lifecycle events
 * (idle / flagAccepted / finished / timedOut) are dispatched here so the
 * scheduler's event.on() subscriptions fire. Same try/catch discipline as
 * {@link RunEmitter}: callbacks are cheap and side-effect-free except send().
 * Created lazily when a scheduler run sets up; cleared when it closes.
 */
export class EventScopeEmitter {
  private readonly subs = new Map<
    EventScopeEvent,
    Set<(e: EventScopePayload) => void>
  >()

  on<E extends EventScopeEvent>(
    event: E,
    cb: (e: Extract<EventScopePayload, { type: E }>) => void
  ): () => void {
    let set = this.subs.get(event)
    if (!set) {
      set = new Set()
      this.subs.set(event, set)
    }
    // The stored callback is invoked with payloads of its own type only
    // (emit dispatches by payload.type), so the widening is sound.
    set.add(cb as (e: EventScopePayload) => void)
    return () => set!.delete(cb as (e: EventScopePayload) => void)
  }

  emit(payload: EventScopePayload): void {
    const set = this.subs.get(payload.type)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (error) {
        console.error("orchestration event.on() callback threw", {
          event: payload.type,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  close(): void {
    this.subs.clear()
  }
}

/** Resolve a slot spec's tool list (static or ctx-aware builder). */
function slotTools(spec: AgentSlotSpec, ctx: PromptContext): string[] {
  return typeof spec.tools === "function" ? spec.tools(ctx) : spec.tools
}

/** Create an {@link AgentHandle} bound to one agent id + the host callbacks. */
function makeAgentHandle(
  agentId: string,
  slot: string,
  role: string,
  host: RunHandleHost
): AgentHandle {
  return {
    id: agentId,
    slot,
    role,
    get isStreaming(): boolean {
      return host.isAgentStreaming(agentId)
    },
    prepare: () => host.prepareAgent(host.runId, agentId),
    send: (text, deliverAs) => host.sendToAgent(agentId, text, deliverAs),
    abort: () => host.abortAgent(agentId),
    on: (event, cb) => host.emitter.onAgent(agentId, event, cb),
  }
}

/** A RunHandle plus the prime specs collected during setup (the system auto
 * prepare()+send(prime) on fresh runs; restore ignores them). */
export type RunHandleImpl = RunHandle & {
  readonly primeSpecs: { agentId: string; slot: string; prime: string }[]
}

/**
 * Build a {@link RunHandle} over a host. The handle owns the per-slot
 * createAgent idempotency logic (fresh = persist snapshot; restore = reuse with
 * snapshot priority) and the in-memory template map. It does NOT own sessions,
 * locks, or containers — those live in the service and are reached through the
 * host.
 *
 * The plugin's declared `agents` are materialized here: one createAgent per
 * slot, each with its model injected from the orchestration settings.
 */
export function createRunHandle(host: RunHandleHost): RunHandleImpl {
  const declared = new Map<string, AgentHandle>()
  const primeSpecs: { agentId: string; slot: string; prime: string }[] = []

  for (const spec of host.agents) {
    const existing = host.findAgentBySlot(spec.slot)
    let agentId: string
    let role: string
    if (existing) {
      // Restore: reuse the existing row verbatim (snapshot priority — spec
      // §4.3). The slot's model spec is ignored; the row's persisted snapshot
      // wins (per-agent model switches survive).
      agentId = existing.id
      role = existing.role
    } else {
      // Fresh: derive per-agent caps, render the system prompt template with
      // this agent's caps + model injected, and persist the snapshot.
      const tools = slotTools(spec, host.ctx)
      const capabilities: Capabilities = deriveCapabilities(tools)
      const slotModel = host.resolveSlotModel(spec.slot)
      const ctxForAgent: PromptContext = {
        ...host.ctx,
        agent: {
          role: spec.role ?? spec.slot,
          isMain: !!spec.entry,
          name: spec.name,
          task: null,
          ...(spec.entry !== undefined ? { isEntry: spec.entry } : {}),
        },
        capabilities,
        model: {
          provider: slotModel.providerLabel,
          name: slotModel.modelLabel,
          id: slotModel.modelId,
        },
      }
      const systemPrompt = renderTemplate(
        host.templateMap,
        spec.systemPrompt,
        ctxForAgent
      )
      agentId = host.createFreshAgent({
        slot: spec.slot,
        role: spec.role ?? spec.slot,
        name: spec.name,
        isEntry: !!spec.entry,
        systemPrompt,
        tools,
        model: slotModel.ref,
      })
      role = spec.role ?? spec.slot
    }

    const handle = makeAgentHandle(agentId, spec.slot, role, host)
    declared.set(spec.slot, handle)
    if (spec.prime) {
      primeSpecs.push({ agentId, slot: spec.slot, prime: host.initialPrompt })
    }
  }

  const impl: RunHandleImpl = {
    id: host.runId,
    scope: host.scope,
    ctx: host.ctx,
    initialPrompt: host.initialPrompt,
    render: (key, extraVars) =>
      renderTemplate(host.templateMap, key, { ...host.ctx, ...extraVars }),
    agent: (slot) => {
      const handle = declared.get(slot)
      if (!handle) throw new Error(`No agent declared for slot: ${slot}`)
      return handle
    },
    get agents() {
      return [...declared.values()]
    },
    on: (event, cb) => host.emitter.onRun(event, cb),
    get primeSpecs() {
      return primeSpecs
    },
  }
  return impl
}
