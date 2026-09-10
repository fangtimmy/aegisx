import type { SolveState } from "./domain"

/**
 * The challenge progress state machine: ONE pure derivation of "how far along
 * is this challenge" from the flag facts. Every consumer — the spawn fence,
 * the solve cleanup, the scheduler digest, the event stats, the wire
 * projection and the Python SDK — reads this instead of re-deriving the rule,
 * so "solved" can never mean two different things in two places.
 *
 * A single-flag challenge is the degenerate case, not a special case:
 * `required === 1` makes `partial` unreachable, so the state space collapses
 * to `unsolved | solved`.
 */
export type ChallengeProgressInputs = {
  /** Distinct flag values recorded as accepted locally. */
  accepted: number
  /** Flags the challenge requires, as the platform reports it. `null` = the
   * platform did not say (single-flag, or an unknown multi-flag chain). */
  requiredFlags: number | null
  /** The platform's terminal verdict. Monotonic on the platform's side; the
   * DERIVED state may still move backwards when `requiredFlags` arrives. */
  remoteSolved: boolean
  /** A platform verdict exists and is authoritative (remoteId && available).
   * When false, the local flag record IS the verdict. */
  integrated: boolean
  /** Operator override. */
  manual: SolveState
  /** Challenge points (null = unscored). Drives the yield figures. */
  points?: number | null
}

/** Which dimension decided the state (structural — the wire carries it as the
 * `source` field; not exported, no consumer names it). */
type ChallengeProgressSource = "manual" | "remote" | "count" | "local"

export type ChallengeProgress = {
  state: SolveState
  /** Which dimension decided `state`. */
  source: ChallengeProgressSource
  /** Accepted flags, clamped to `required` (progress never exceeds 100%). */
  confirmed: number
  /** Flags required; always ≥ 1. */
  required: number
  /** Points already earned, derived from the platform's per-flag split
   * (points × confirmed / required). Null when the challenge is unscored. */
  earned: number | null
  /** Value of the NEXT flag (points / required) — the marginal-value figure a
   * multi-flag chain must be ranked by, not the chain total. Null when
   * unscored. */
  perFlag: number | null
}

export function progressOf(inputs: ChallengeProgressInputs): ChallengeProgress {
  const required = Math.max(inputs.requiredFlags ?? 1, 1)
  const confirmed = Math.min(Math.max(inputs.accepted, 0), required)
  const points = inputs.points ?? null

  const yieldOf = (): { earned: number | null; perFlag: number | null } => ({
    earned:
      points === null ? null : Math.round((points * confirmed) / required),
    perFlag: points === null ? null : Math.round(points / required),
  })

  const decide = (): { state: SolveState; source: ChallengeProgressSource } => {
    if (inputs.manual === "solved") return { state: "solved", source: "manual" }
    if (inputs.manual === "partial")
      return { state: "partial", source: "manual" }
    if (inputs.remoteSolved) return { state: "solved", source: "remote" }
    if (confirmed === 0) return { state: "unsolved", source: "local" }
    // No platform verdict to wait on: the local record settles it.
    if (!inputs.integrated) return { state: "solved", source: "local" }
    // Platform-integrated: an accepted row may be a multi-flag partial, so the
    // count only settles it when the platform told us how many flags exist.
    if (inputs.requiredFlags !== null && confirmed >= required) {
      return { state: "solved", source: "count" }
    }
    return { state: "partial", source: "count" }
  }

  const { state, source } = decide()
  return { state, source, confirmed, required, ...yieldOf() }
}
