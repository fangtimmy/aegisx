import type { Database } from "../db"
import type { ChannelService } from "./channels"
import { emitDomainEvent } from "./domain-events/store"
import { RunActionError } from "./errors"
import type { AgentKernel, SpawnAgentInput } from "./kernel"
import type { AgentEventPoster } from "./lifecycle-reactor"

export type SpawnServiceDeps = {
  db: Database
  kernel: AgentKernel
  channels: ChannelService
  poster: AgentEventPoster
}

export type SpawnService = ReturnType<typeof createSpawnService>

/**
 * The L3 launch entry — the single door both the queue drainer and the
 * user-facing routes spawn through. NOT a bare kernel verb: it composes the
 * launch sequence around the kernel's admission-carrying `prepare` —
 * generate the id, prepare (render → admission critical section → row →
 * container → session), prime the first turn, sweep the channel backlog,
 * arm the deadline and land the started fact + line. A failure after the
 * row insert lands the agent `failed` through the kernel's single terminal
 * path, exactly like the pre-split spawn did.
 */
export function createSpawnService(deps: SpawnServiceDeps) {
  const { db, kernel, channels, poster } = deps

  async function launch(input: SpawnAgentInput): Promise<string> {
    const agentId = crypto.randomUUID()
    const { initialPrompt, deadlineAt } = await kernel.prepare(agentId, input)
    try {
      await kernel.send(agentId, initialPrompt)
      // Onboarding: a fresh agent's channel cursor is 0 — one deliver sweeps
      // the challenge's whole #team history (prior attempts' findings +
      // announce) into the first turn's tail.
      channels.deliver(agentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Land through the runtime's single terminal path. A failure after the
      // session was mounted (send / delivery) otherwise strands a runtime
      // entry holding a live session; settling disposes that session and
      // forgets the runtime.
      await kernel.settle(agentId, {
        abort: false,
        status: "failed",
        error: `Failed to start agent: ${message}`,
        by: { kind: "system", actorId: "spawn-failure" },
      })
      throw new RunActionError("launch_failed", message)
    }

    kernel.armDeadline(agentId, deadlineAt)
    kernel.emitAgent(agentId)
    poster(agentId, { type: "agent.started", agentId })
    emitDomainEvent(db, {
      type: "agent.started",
      eventId: input.eventId,
      challengeId: input.challengeId,
      agentId,
      actor: input.actor,
      payload: {},
    })
    return agentId
  }

  return { launch }
}
