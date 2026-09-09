/** Channel-layer wire types (design rationale in docs/archive/model-v19-challenge-centric.md).
 * Canonical definition — the server's channel service and the web UI both
 * import from here.
 *
 * A channel is a DERIVED KEY, not a table row — `team:<challengeId>`
 * (#team, shared by every agent on the challenge), `dm:<agentId>`
 * (scheduler/user/system → one solver), `orch:<eventId>` (solver asks +
 * system agent/queue events → the scheduler). The first message makes a
 * channel "exist"; there is no directory table and no get-or-create. */

/** The three derived-key shapes. */
type ChannelKind = "team" | "dm" | "orch"

/** One channel entry (GET /api/challenges/:id/channels etc.). `unread` is the
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
  unread: number
  lastMessageAt: string | null
  /** team only: how many live (running/idle) agents currently share this
   * channel — the UI's 共享 badge. Null otherwise. */
  liveAgentCount: number | null
}

/** Typed message meta — the single contract between the server (stamps +
 * parses it), the SDK and the web UI. The server's toPublic keeps only these
 * known keys (defensive parse of the stored JSON). */
export type ChannelMessageMeta = {
  /** urgent=true → delivered immediately (else rides the flush tick). */
  urgent?: true
  /** Agent posts: the author's agent id (server-stamped, spoof-proof).
   * System posts: the agent the event is about. */
  agentId?: string
  /** System lifecycle posts: how the agent was started (manual vs scheduler). */
  source?: "manual" | "scheduler"
  /** System posts: agent.started | agent.idle | agent.flagAccepted |
   * agent.finished | agent.timedOut | agent.reopened | flagPartial. */
  eventType?: string
  /** System posts: ordinary notice vs emergency. */
  noticeType?: "notice" | "emergency"
  /** Agent posts: free-form tags (SDK post). */
  tags?: string[]
}

/** One attachment on a channel message: the file was copied into the
 * challenge workspace's `shared/` tree at post time. `path` is
 * workspace-relative (`shared/from-<agentId8>/<filename>`); solvers read it
 * at `<workspace root>/shared/...` in their container, the scheduler via its
 * read-only `/challenges/<cid>/workspace/shared/...` mount. */
export type ChannelFileMeta = {
  path: string
  filename: string
  size: number
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
  files: ChannelFileMeta[]
}

/** Paginated channel timeline (GET /api/channels/:channelKey/messages). */
export type ChannelMessageList = {
  items: ChannelMessagePublic[]
  nextAfter: number
  hasMore: boolean
}

/** `4.2KB`-style attachment sizes for 📎 lines and file rows (server renders
 * them into delivery texts, the web UI mirrors the same format). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)}KB`
  }
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}MB`
}
