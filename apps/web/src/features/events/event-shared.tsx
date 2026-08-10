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
 * Merge the three solve dimensions by priority manual > remote > local
 * (first non-`unsolved` wins). `solved` > `partial` > `unsolved`.
 */
export function overallSolved(challenge: Challenge): SolveState {
  const { manual, remote, local } = challenge.solved
  if (manual !== "unsolved") return manual
  if (remote !== "unsolved") return remote
  return local
}

export function localChallengeStatus(
  challenge: Challenge
): LocalChallengeStatus {
  const overall = overallSolved(challenge)
  if (overall === "solved") return "solved"
  if (overall === "partial" || challenge.runCount > 0) return "in_progress"
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
