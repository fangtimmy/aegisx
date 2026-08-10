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

/** Per-dimension solve state. `solved` > `partial` > `unsolved`. */
export type SolveState = "solved" | "partial" | "unsolved"

/** A recorded flag for a challenge (one-to-many — 一题多解). */
export type ChallengeFlag = {
  id: string
  challengeId: string
  flag: string
  status: "pending" | "accepted" | "rejected" | "error"
  source: "run" | "manual"
  runId: string | null
  remoteId: string | null
  message: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Solve state split into three independent dimensions, merged by priority
 * `manual > remote > local` (first non-`unsolved` wins):
 *  - `local`: derived — `accepted` iff an accepted flag exists, else `unsolved`.
 *  - `manual`: user-assigned override (stored on `challenges.manual_solve_state`).
 *  - `remote`: platform verdict (`challenge_remote.solved` mapped to solved/unsolved).
 */
export type ChallengeSolved = {
  local: SolveState
  manual: SolveState
  remote: SolveState
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
  flags: ChallengeFlag[]
  solved: ChallengeSolved
  runCount: number
  runStatusCounts: Record<RunStatus, number>
  remoteId: string | null
  remoteAvailable: boolean
  remoteTarget: boolean
  remoteTargetIgnored: boolean
  remoteTargetCount: number
  targets: RemoteTargetInfo[]
  remoteUpdatedAt: string | null
}
