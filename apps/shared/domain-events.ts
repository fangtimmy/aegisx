/** Domain event stream wire types (control-plane design §A). The stream is
 * the control plane's append-only fact log; projection tables are derived
 * state. This module carries the decision-log API's wire shapes
 * (GET /api/events/:eventId/decisions); the per-type payload registry lives
 * server-side (apps/server/src/run/domain-events/registry.ts). */

/** Who produced a fact. `actorId` disambiguates within a kind: the agent id
 * for agents, a subsystem tag ('drainer' / 'progress-machine' /
 * 'platform-sync' / ...) for system. */
export type DomainEventActorKind = "user" | "agent" | "system"

/** One decision-log entry: a domain event from the decision-log type set.
 * `payload` is the type-registered JSON (shape documented per type in the
 * server-side registry). */
export type DecisionLogEntry = {
  id: number
  type: string
  eventId: string | null
  challengeId: string | null
  agentId: string | null
  actorKind: DomainEventActorKind
  actorId: string | null
  /** The triggering event's id, when one was naturally at hand. */
  causationId: number | null
  payload: Record<string, unknown>
  createdAt: string
}

/** GET /api/events/:eventId/decisions — newest-first page over the event's
 * decision-log entries. */
export type DecisionLogPage = {
  items: DecisionLogEntry[]
  /** Echo back as `beforeId` for the next (older) page; null = exhausted. */
  nextBeforeId: number | null
}
