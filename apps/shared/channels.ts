/** Channel-layer wire types (docs/im-simplify-v18.md). Canonical definition —
 * the server's channel service, the Python SDK and the web UI all import
 * from here.
 *
 * v18: a channel is a DERIVED KEY, not a table row — `team:<challengeId>`
 * (#team, shared by every run on the challenge), `dm:<agentId>` (scheduler/
 * user/system → one solver), `orch:<eventId>` (solver asks + system run/queue
 * events → the scheduler). The first message makes a channel "exist"; there
 * is no directory table and no get-or-create. */

/** The three derived-key shapes. */
export type ChannelKind = "team" | "dm" | "orch"

/** One channel entry (GET /api/runs/:id/channels etc.). `unread` is the
 * per-reader cursor delta (SDK list); UI trees pass a null reader and get 0. */
export type ChannelPublic = {
  /** Derived key: "team:<challengeId>" | "dm:<agentId>" | "orch:<eventId>". */
  key: string
  kind: ChannelKind
  /** Display label: "#team" / "DM <agent label>" / "#orch". */
  label: string
  eventId: string
  /** team: the owning challenge. */
  challengeId: string | null
  /** dm: the target agent. */
  agentId: string | null
  /** dm: the target agent's run (UI routing / SSE split). */
  runId: string | null
  unread: number
  lastMessageAt: string | null
  /** team only: how many live (running/idle) runs currently share this
   * channel — the UI's 共享 badge. Null otherwise. */
  sharedRunCount: number | null
}

/** Typed message meta — the single contract between the server (stamps +
 * parses it), the SDK and the web UI. The server's toPublic keeps only these
 * known keys (defensive parse of the stored JSON). */
export type ChannelMessageMeta = {
  /** urgent=true → delivered immediately (else rides the flush tick). */
  urgent?: true
  /** Agent posts: the author's run (server-stamped, spoof-proof). System
   * posts: the run the event is about. */
  runId?: string
  /** System lifecycle posts: how the run was started (manual vs scheduler). */
  source?: "manual" | "scheduler"
  /** System posts: run.started | run.idle | run.flagAccepted | run.finished |
   * run.timedOut | run.resumed | flagPartial. */
  eventType?: string
  /** System posts: ordinary notice vs emergency. */
  noticeType?: "notice" | "emergency"
  /** Agent posts: free-form tags (SDK post). */
  tags?: string[]
}

/** One channel message (timeline + SDK read + SSE push). */
export type ChannelMessagePublic = {
  id: number
  channelKey: string
  authorType: "system" | "user" | "agent"
  authorAgentId: string | null
  authorName: string
  body: string
  meta: ChannelMessageMeta
  createdAt: string
  files: Array<{ id: string; filename: string; size: number }>
}

/** Paginated channel timeline (GET /api/channels/:channelKey/messages). */
export type ChannelMessageList = {
  items: ChannelMessagePublic[]
  nextAfter: number
  hasMore: boolean
}
