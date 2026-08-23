import type { ChannelMessageList, ChannelMessagePublic } from "@/api"

/** Merge incoming channel messages into an existing ascending-by-id list,
 * de-duplicating by id — the HTTP window, the SSE snapshot replay and the
 * reconciliation poll can each deliver the same message (and a late-resolving
 * initial window must slot before already-pushed live messages). Returns the
 * previous array when nothing changed so React state updates stay no-ops. */
export function mergeChannelMessages(
  prev: ChannelMessagePublic[],
  fresh: readonly ChannelMessagePublic[]
): ChannelMessagePublic[] {
  const seen = new Set(prev.map((message) => message.id))
  const incoming = fresh.filter((message) => !seen.has(message.id))
  if (incoming.length === 0) return prev
  return [...prev, ...incoming].toSorted((a, b) => a.id - b.id)
}

/** Append one live (SSE) message into a channel-messages cache entry,
 * advancing the `after` cursor so the reconciliation poll never re-fetches
 * what the stream already delivered. */
export function appendChannelMessage(
  prev: ChannelMessageList | undefined,
  message: ChannelMessagePublic
): ChannelMessageList {
  const items = mergeChannelMessages(prev?.items ?? [], [message])
  return {
    items,
    nextAfter: Math.max(prev?.nextAfter ?? 0, message.id),
    hasMore: prev?.hasMore ?? false,
  }
}
