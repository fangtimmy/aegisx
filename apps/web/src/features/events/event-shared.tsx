import { TriangleAlert } from "lucide-react"

import type { Challenge, SolveState } from "@/api"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export type LocalChallengeStatus = "not_started" | "in_progress" | "solved"
export type RemoteChallengeStatus =
  | "no_remote"
  | "unsolved"
  | "solved"
  | "unavailable"

/**
 * The challenge's progress state, straight from the server's state machine
 * (`challenge.progress.state`) — never re-derived here. A partially solved
 * multi-flag chain reads `partial`, so the badge and the filters agree with
 * the spawn fence and the scheduler digest.
 */
export function overallSolved(challenge: Challenge): SolveState {
  return challenge.progress.state
}

export function localChallengeStatus(
  challenge: Challenge
): LocalChallengeStatus {
  const overall = overallSolved(challenge)
  if (overall === "solved") return "solved"
  if (overall === "partial" || challenge.agentCount > 0) return "in_progress"
  return "not_started"
}

export function remoteChallengeStatus(
  challenge: Challenge
): RemoteChallengeStatus {
  if (!challenge.remoteId) return "no_remote"
  if (!challenge.remoteAvailable) return "unavailable"
  if (challenge.solved.remote === "solved") return "solved"
  return "unsolved"
}

export function isChallengeSolved(challenge: Challenge) {
  return overallSolved(challenge) === "solved"
}

export function ErrorState({
  error,
  retry,
}: {
  error: Error
  retry: () => void
}) {
  return (
    <Alert variant="error">
      <TriangleAlert />
      <AlertTitle>无法加载数据</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      <AlertAction>
        <Button onClick={retry} size="xs" type="button" variant="ghost">
          重试
        </Button>
      </AlertAction>
    </Alert>
  )
}
