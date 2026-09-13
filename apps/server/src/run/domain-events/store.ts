import type { Database } from "../../db"
import { domainEvents } from "../../db/schema"
import type { Principal } from "../../infrastructure/agent-auth"
import { projectDomainEvent } from "./projector"
import {
  validateDomainEventPayload,
  type DomainEventPayloadOf,
  type DomainEventType,
} from "./registry"

/** Who produced a fact: the user principal, an agent (by id), or an in-process
 * subsystem (by tag — 'drainer' / 'boot-recovery' / 'progress-machine' /
 * 'platform-sync' / ...). */
export type DomainEventActor =
  | { kind: "user" }
  | { kind: "agent"; agentId: string }
  | { kind: "system"; actorId: string }

export function actorFromPrincipal(
  principal: Principal,
  systemActorId = "system"
): DomainEventActor {
  if (principal.kind === "agent") {
    return { kind: "agent", agentId: principal.agentId }
  }
  if (principal.kind === "system") {
    return { kind: "system", actorId: systemActorId }
  }
  return { kind: "user" }
}

export type DomainEventInput<T extends DomainEventType = DomainEventType> = {
  type: T
  /** Hot dimensions — pass what the fact naturally carries, null otherwise. */
  eventId?: string | null
  challengeId?: string | null
  agentId?: string | null
  actor: DomainEventActor
  /** The triggering event's id, when one is naturally at hand. */
  causationId?: number | null
  payload: DomainEventPayloadOf<T>
}

export type DomainEventEmitResult = {
  id: number
  /** Whether the projection changed a row (guarded updates can miss). */
  applied: boolean
}

/**
 * Append one fact + apply its projection in the SAME SQLite transaction —
 * strong consistency, zero-latency projection (bun:sqlite is synchronous; a
 * nested call inside an open transaction degrades to a savepoint). The
 * payload is validated against the registry first: an invalid payload throws
 * before anything is written.
 */
export function emitDomainEvent<T extends DomainEventType>(
  db: Database,
  input: DomainEventInput<T>
): DomainEventEmitResult {
  const problem = validateDomainEventPayload(input.type, input.payload)
  if (problem) {
    throw new Error(`domain event "${input.type}" payload rejected: ${problem}`)
  }
  let result: DomainEventEmitResult = { id: 0, applied: false }
  db.transaction((tx) => {
    const actorId =
      input.actor.kind === "agent"
        ? input.actor.agentId
        : input.actor.kind === "system"
          ? input.actor.actorId
          : null
    const inserted = tx
      .insert(domainEvents)
      .values({
        type: input.type,
        eventId: input.eventId ?? null,
        challengeId: input.challengeId ?? null,
        agentId: input.agentId ?? null,
        actorKind: input.actor.kind,
        actorId,
        causationId: input.causationId ?? null,
        payload: JSON.stringify(input.payload),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: domainEvents.id })
      .get()
    const id = inserted?.id ?? 0
    const applied = projectDomainEvent(tx, {
      id,
      type: input.type,
      eventId: input.eventId ?? null,
      challengeId: input.challengeId ?? null,
      agentId: input.agentId ?? null,
      payload: input.payload,
    })
    result = { id, applied }
  })
  return result
}
