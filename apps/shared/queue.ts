/** Task-queue wire types (GET /api/events/:id/queue + the enqueue endpoints).
 * Canonical definition — the server's queue service and the web UI both
 * import from here (no hand-mirrored duplicates). */

/** Public queue item shape (REST + tools). */
export type QueueItemPublic = {
  id: string
  eventId: string
  ord: number
  challengeId: string
  challengeName: string
  params: Record<string, unknown>
  timeoutMs: number | null
  prompt: string
  source: "manual" | "scheduler"
  status: "pending" | "running" | "done" | "cancelled" | "failed"
  runId: string | null
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
