import type { EventPlatform } from "./platform"

export type EventInput = {
  name: string
  promptHint?: string
}

export type EventSummary = {
  id: string
  name: string
  promptHint: string
  platform: EventPlatform | null
  createdAt: string
  updatedAt: string
  challengeCount: number
  solvedCount: number
  activeRunCount: number
  lastActivityAt: string
}
