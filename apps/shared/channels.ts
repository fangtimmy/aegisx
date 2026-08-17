/** Channel-layer wire types (docs/im-channels.md). Canonical definition —
 * the server's channel service and the web UI both import from here. */

/** One channel in a run's tree / challenge tree (GET /api/runs/:id/channels
 * etc.). v17: #team/#announce are challenge-scoped (shared across the
 * challenge's runs — `sharedRunCount` = live runs on the challenge, the UI
 * 共享 badge). */
export type ChannelPublic = {
  id: string
  scopeType: "run" | "event" | "challenge"
  runId: string | null
  eventId: string
  /** Challenge scope (#team/#announce, v17): the owning challenge. */
  challengeId: string | null
  kind: "team" | "announce" | "dm"
  targetAgentId: string | null
  /** Display label: "#team" / "#announce" / "DM <agentName>". */
  label: string
  unread: number
  lastMessageAt: string | null
  /** Challenge-scope channels only (v17 §11.5): how many live runs currently
   * share this channel — the UI's 共享 badge. Null for DM/scheduler DM. */
  sharedRunCount: number | null
}

/** One channel message (timeline + SDK read). */
export type ChannelMessagePublic = {
  id: number
  channelId: string
  kind: "text" | "recap"
  authorType: "system" | "user" | "agent"
  authorAgentId: string | null
  authorName: string
  body: string
  meta: Record<string, unknown>
  createdAt: string
  files: Array<{ id: string; filename: string; size: number }>
}

/** Paginated channel timeline (GET /api/channels/:id/messages). */
export type ChannelMessageList = {
  items: ChannelMessagePublic[]
  nextAfter: number
  hasMore: boolean
}
