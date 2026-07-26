import {
  type ChallengeSyncItem,
  type ChallengeSyncProgress,
  type ChallengeSyncResult,
  jsonRequest,
} from "@/api"

export type SyncStreamEvent =
  | {
      type: "progress"
      progress: ChallengeSyncProgress
    }
  | {
      type: "item"
      item: ChallengeSyncItem
      completed: number
      total: number
    }
  | { type: "complete"; syncedAt: string }
  | { type: "error"; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAttachment(value: unknown) {
  if (!isRecord(value)) return false
  return (
    typeof value.filename === "string" &&
    typeof value.size === "number" &&
    (value.status === "downloaded" || value.status === "updated")
  )
}

function isResult(value: unknown): value is ChallengeSyncItem {
  if (!isRecord(value) || typeof value.remoteId !== "string") return false
  if (
    value.status !== "created" &&
    value.status !== "updated" &&
    value.status !== "failed"
  ) {
    return false
  }
  if (
    value.challengeId !== undefined &&
    typeof value.challengeId !== "string"
  ) {
    return false
  }
  if (value.error !== undefined && typeof value.error !== "string") return false
  if (value.name !== undefined && typeof value.name !== "string") return false
  if (
    value.category !== undefined &&
    value.category !== null &&
    typeof value.category !== "string"
  ) {
    return false
  }
  if (
    value.points !== undefined &&
    value.points !== null &&
    typeof value.points !== "number"
  ) {
    return false
  }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) return false
    if (!value.attachments.every(isAttachment)) return false
  }
  return true
}

function isProgress(value: unknown): value is ChallengeSyncProgress {
  if (!isRecord(value) || typeof value.remoteId !== "string") return false
  if (
    value.phase !== "fetching" &&
    value.phase !== "metadata" &&
    value.phase !== "attachment"
  ) {
    return false
  }
  if (typeof value.message !== "string") return false
  if (value.name !== undefined && typeof value.name !== "string") return false
  if (
    value.category !== undefined &&
    value.category !== null &&
    typeof value.category !== "string"
  ) {
    return false
  }
  if (
    value.points !== undefined &&
    value.points !== null &&
    typeof value.points !== "number"
  ) {
    return false
  }
  if (value.attachment !== undefined) {
    if (!isRecord(value.attachment)) return false
    if (typeof value.attachment.filename !== "string") return false
    if (typeof value.attachment.index !== "number") return false
    if (typeof value.attachment.total !== "number") return false
  }
  return true
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
  if (value.type === "progress") {
    if (!isProgress(value.progress)) {
      throw new Error("Invalid challenge sync event")
    }
    return { type: "progress", progress: value.progress }
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
  onEvent: (
    event: Extract<SyncStreamEvent, { type: "progress" | "item" }>
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
    if (event.type === "item") {
      results.push(event.item)
    }
    onEvent(event)
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
