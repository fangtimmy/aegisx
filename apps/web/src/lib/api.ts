export type EventSummary = {
  id: string
  name: string
  description: string
  startsAt: string | null
  endsAt: string | null
  createdAt: string
  updatedAt: string
  challengeCount: number
}

export type Attachment = {
  id: string
  challengeId: string
  originalName: string
  size: number
  sha256: string
  createdAt: string
  downloadUrl: string
}

export type Challenge = {
  id: string
  eventId: string
  name: string
  description: string
  category: string | null
  points: number | null
  createdAt: string
  updatedAt: string
  attachments: Attachment[]
  runCount: number
  status: "not_started"
}

export type EventInput = {
  name: string
  description: string
  startsAt: string | null
  endsAt: string | null
}

export type ChallengeInput = {
  name: string
  description: string
  category: string | null
  points: number | null
}

export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"

export type RunPublic = {
  id: string
  challengeId: string
  challengeName: string
  eventId: string
  status: RunStatus
  provider: string
  modelId: string
  environment: "local"
  createdAt: string
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
  error: string | null
  summary: string | null
  flag?: string | null
}

export type SessionEntry = {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: unknown
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`/api${path}`, init)

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`

    try {
      const body = (await response.json()) as {
        error?: { message?: string }
      }
      if (body.error?.message) {
        message = body.error.message
      }
    } catch {
      // Keep the HTTP status when the server does not return its JSON error shape.
    }

    throw new Error(message || "The request failed")
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export function jsonRequest(method: "POST" | "PATCH", body: object) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } satisfies RequestInit
}
