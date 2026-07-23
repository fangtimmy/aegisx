import { type ChallengeSyncResult, jsonRequest } from "@/api"

type SyncStreamEvent =
  | {
      type: "item"
      item: ChallengeSyncResult["results"][number]
      completed: number
      total: number
    }
  | { type: "complete"; syncedAt: string }
  | { type: "error"; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isResult(
  value: unknown
): value is ChallengeSyncResult["results"][number] {
  if (!isRecord(value) || typeof value.remoteId !== "string") return false
  if (
    value.status !== "created" &&
    value.status !== "updated" &&
    value.status !== "failed"
  ) {
    return false
  }
  return (
    (value.challengeId === undefined ||
      typeof value.challengeId === "string") &&
    (value.error === undefined || typeof value.error === "string")
  )
}

export function parseSyncStreamLine(line: string): SyncStreamEvent | undefined {
  if (!line.trim()) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("Invalid challenge sync event")
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid challenge sync event")
  }
  if (value.type === "item") {
    if (
      !isResult(value.item) ||
      typeof value.completed !== "number" ||
      typeof value.total !== "number"
    ) {
      throw new Error("Invalid challenge sync event")
    }
    return {
      type: "item",
      item: value.item,
      completed: value.completed,
      total: value.total,
    }
  }
  if (value.type === "complete" && typeof value.syncedAt === "string") {
    return { type: "complete", syncedAt: value.syncedAt }
  }
  if (value.type === "error" && typeof value.message === "string") {
    return { type: "error", message: value.message }
  }
  throw new Error("Invalid challenge sync event")
}

export async function syncChallengeStream(
  eventId: string,
  remoteIds: string[],
  onItem: (
    item: ChallengeSyncResult["results"][number],
    completed: number,
    total: number
  ) => void
) {
  const response = await fetch(
    `/api/events/${eventId}/platform/challenges/sync/stream`,
    jsonRequest("POST", { remoteIds })
  )
  if (!response.ok) throw new Error(`Sync failed (${response.status})`)
  if (!response.body) throw new Error("Sync stream is unavailable")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const results: ChallengeSyncResult["results"] = []
  let buffer = ""
  let syncedAt = ""
  const consume = (line: string) => {
    const event = parseSyncStreamLine(line)
    if (!event) return
    if (event.type === "error") throw new Error(event.message)
    if (event.type === "complete") {
      syncedAt = event.syncedAt
      return
    }
    results.push(event.item)
    onItem(event.item, event.completed, event.total)
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) consume(line)
    if (done) break
  }
  consume(buffer)
  if (!syncedAt) throw new Error("Sync stream ended unexpectedly")
  return { syncedAt, results }
}
