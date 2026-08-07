import type { RunStatus } from "./run-status"
import type { RemoteTargetInfo } from "./target"

export type Attachment = {
  id: string
  challengeId: string
  originalName: string
  size: number
  sha256: string
  createdAt: string
  downloadUrl: string
}

export type ChallengeInput = {
  name: string
  description: string
  category: string | null
  points: number | null
}

export type ChallengeStatus = "not_started" | "in_progress" | "solved"

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
  runStatusCounts: Record<RunStatus, number>
  remoteId: string | null
  remoteAvailable: boolean
  remoteSolved: boolean
  remoteTarget: boolean
  remoteTargetIgnored: boolean
  remoteTargetCount: number
  targets: RemoteTargetInfo[]
  remoteUpdatedAt: string | null
  status: ChallengeStatus
}
