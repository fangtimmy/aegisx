/** Task-queue wire types (GET /api/events/:id/queue + the enqueue endpoints).
 * Canonical definition — the server's queue service and the web UI both
 * import from here (no hand-mirrored duplicates).
 *
 * v19: a queue item = "spawn one agent on challenge X". Enqueue always
 * appends — one challenge may hold several pending items (parallel attempts
 * are a legal plan). */

/** The spawn specs a queue item carries (the parsed `params` JSON column). */
export type SpawnQueueParams = {
  model?: string
  prompt?: string
  promptMode?: "strategy" | "override"
}

/** Public queue item shape (REST + tools). */
export type QueueItemPublic = {
  id: string
  eventId: string
  ord: number
  challengeId: string
  challengeName: string
  params: SpawnQueueParams
  timeoutMs: number | null
  /** Display copy of params.prompt (the queue list's strategy column). */
  prompt: string
  source: "manual" | "scheduler"
  status: "pending" | "running" | "done" | "cancelled" | "failed"
  /** Back-filled when the drainer launches the agent. */
  agentId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** Per-event queue state (absent row = running). */
export type QueueState = "running" | "paused"

/** GET /api/events/:id/queue — items + the event's queue state. */
export type QueueSnapshot = {
  items: QueueItemPublic[]
  state: QueueState
}
