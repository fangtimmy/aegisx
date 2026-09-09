import { setTimeout as sleep } from "node:timers/promises"

import type { ChallengeFlag } from "@aegisx/shared"
import { and, asc, eq } from "drizzle-orm"

import type { Database } from "../db"
import {
  challengeFlags,
  challengeRemote,
  challenges,
  type eventPlatforms,
} from "../db/schema"
import {
  fullySolved,
  fullySolvedAsideFromFlag,
  getChallengeRemote,
  isPlatformIntegrated,
} from "./challenge-state"
import {
  type CtfPlatformAdapter,
  PlatformError,
  type SubmissionResult,
} from "./core"
import { PlatformActionError, platformError } from "./errors"
import { toFlagPublic } from "./wire"

type StoredPlatform = typeof eventPlatforms.$inferSelect

/** Async-judge polling cadence (a1ctf/ret2 return a judge id then resolve). */
const SUBMISSION_POLL_INTERVAL_MS = 1000
const SUBMISSION_POLL_MAX_ATTEMPTS = 60

export type FlagSubmissionResult = {
  status: ChallengeFlag["status"]
  message?: string
  remoteId?: string
  /** Whether the platform was actually contacted for verification. */
  verified: boolean
}

export type FlagAcceptOutcome =
  /** This acceptance solved the challenge for the first time. */
  | "first"
  /** The same flag value was already accepted — nothing new to orchestrate. */
  | "repeat"
  /** A fresh flag value on an already-solved challenge (一题多解 / dynamic
   * flags): record + a light notice, no cleanup round. */
  | "extra"

/** Collapse an adapter verdict into a challenge_flags status. The adapter may
 * distinguish accepted/already_solved/partial, but at the flag level all three
 * mean "this flag was verified correct". */
function flagStatusFromResult(
  status: SubmissionResult["status"]
): ChallengeFlag["status"] {
  if (
    status === "accepted" ||
    status === "already_solved" ||
    status === "partial"
  )
    return "accepted"
  if (status === "rejected") return "rejected"
  if (status === "pending") return "pending"
  return "error"
}

export function createPlatformFlags(
  db: Database,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined,
  options?: {
    /** Notify the agent layer after a flag becomes platform-accepted. The
     * outcome tier shapes the response: "first" = the challenge's initial
     * solve (agent event + full-solve cleanup), "extra" = a new flag value on
     * an already-solved challenge (light notice only), "repeat" = a duplicate
     * submission of an already-accepted value (no orchestration). */
    onAgentFlagAccepted?(
      challengeId: string,
      agentId?: string,
      outcome?: FlagAcceptOutcome
    ): void
    /** Notify the agent layer after a correct-but-incomplete multi-flag
     * submission (TSecBench partial): steers the challenge's agents toward
     * the remaining flags. */
    onAgentFlagPartial?(
      challengeId: string,
      message: string | null,
      agentId?: string
    ): void
  }
) {
  function lookup(challengeId: string, flag: string) {
    return db
      .select()
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.flag, flag)
        )
      )
      .get()
  }

  function listFlags(challengeId: string): ChallengeFlag[] {
    return db
      .select()
      .from(challengeFlags)
      .where(eq(challengeFlags.challengeId, challengeId))
      .orderBy(asc(challengeFlags.createdAt), asc(challengeFlags.id))
      .all()
      .map(toFlagPublic)
  }

  function addManualFlag(challengeId: string, flag: string): ChallengeFlag {
    const value = flag.trim()
    const now = new Date().toISOString()
    const existing = lookup(challengeId, value)
    if (existing) {
      if (existing.status !== "accepted" || existing.source !== "manual") {
        db.update(challengeFlags)
          .set({ status: "accepted", source: "manual", updatedAt: now })
          .where(eq(challengeFlags.id, existing.id))
          .run()
      }
      return {
        ...toFlagPublic(existing),
        status: "accepted",
        source: "manual",
        updatedAt: now,
      }
    }
    const id = crypto.randomUUID()
    const row = {
      id,
      challengeId,
      flag: value,
      status: "accepted" as const,
      source: "manual" as const,
      agentId: null,
      remoteId: null,
      message: null,
      createdAt: now,
      updatedAt: now,
    }
    db.insert(challengeFlags).values(row).run()
    return toFlagPublic({ ...row })
  }

  function deleteFlag(challengeId: string, flagId: string): boolean {
    const existing = db
      .select({ id: challengeFlags.id })
      .from(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.id, flagId)
        )
      )
      .get()
    if (!existing) return false
    db.delete(challengeFlags)
      .where(
        and(
          eq(challengeFlags.challengeId, challengeId),
          eq(challengeFlags.id, flagId)
        )
      )
      .run()
    return true
  }

  async function submitFlag(
    challengeId: string,
    agentId: string,
    flag: string | undefined,
    verifyRemote = true,
    signal?: AbortSignal
  ): Promise<FlagSubmissionResult> {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (!challenge) {
      throw new PlatformActionError("not_found", "Challenge not found")
    }
    if (!flag?.trim()) {
      throw new PlatformActionError("invalid_state", "A flag is required")
    }
    const value = flag.trim()
    const platform = storedPlatform(challenge.eventId)
    const remote = getChallengeRemote(db, challengeId)
    const integrated = Boolean(
      remote &&
      platform &&
      isPlatformIntegrated(remote) &&
      remote.sourceKey === platform.sourceKey
    )

    // Terminal cache: a flag already verified accepted/rejected is not re-submitted.
    const existing = lookup(challengeId, value)
    if (
      existing &&
      (existing.status === "accepted" || existing.status === "rejected")
    ) {
      // A repeat submission of an accepted flag still counts for the
      // submitting agent — but "accepted" at flag level also covers a
      // multi-flag partial (collapsed on persist), and only a FULLY solved
      // challenge may fire agent.flagAccepted (its cleanup stops the
      // challenge's other agents). On a partially-solved challenge the
      // repeat steers instead.
      if (existing.status === "accepted") {
        // Integrated platform → `challenge_remote.solved` is the full verdict
        // (multi-flag partials never set it); non-integrated → an accepted
        // flag IS the full local verdict.
        const solved = integrated ? Boolean(remote?.solved) : true
        if (solved) {
          options?.onAgentFlagAccepted?.(challengeId, agentId, "repeat")
        } else {
          options?.onAgentFlagPartial?.(challengeId, null, agentId)
        }
      }
      return {
        status: existing.status,
        ...(existing.message ? { message: existing.message } : {}),
        ...(existing.remoteId ? { remoteId: existing.remoteId } : {}),
        verified:
          integrated && existing.status !== "accepted"
            ? existing.status === "rejected"
            : Boolean(existing.remoteId),
      }
    }

    // Non-platform challenge: record as a locally-confirmed accepted flag.
    if (!integrated) {
      // Judged BEFORE the write: the prior solve state decides the tier.
      const outcome: FlagAcceptOutcome = fullySolved(db, challengeId)
        ? "extra"
        : "first"
      const now = new Date().toISOString()
      const row = {
        id: existing?.id ?? crypto.randomUUID(),
        challengeId,
        flag: value,
        status: "accepted" as const,
        source: "agent" as const,
        agentId,
        remoteId: null,
        message: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (existing) {
        db.update(challengeFlags)
          .set({ status: "accepted", source: "agent", agentId, updatedAt: now })
          .where(eq(challengeFlags.id, existing.id))
          .run()
      } else {
        db.insert(challengeFlags).values(row).run()
      }
      // No remote judge here, but the acceptance is real — notify the agent
      // layer so the scheduler learns the flag (agent.flagAccepted). No
      // platform → no multi-flag partial: accepted IS the full verdict.
      options?.onAgentFlagAccepted?.(challengeId, agentId, outcome)
      return { status: "accepted", verified: false }
    }

    // Platform challenge, but verification explicitly skipped: store as pending.
    if (!verifyRemote) {
      const now = new Date().toISOString()
      if (existing) {
        db.update(challengeFlags)
          .set({ status: "pending", source: "agent", agentId, updatedAt: now })
          .where(eq(challengeFlags.id, existing.id))
          .run()
      } else {
        db.insert(challengeFlags)
          .values({
            id: crypto.randomUUID(),
            challengeId,
            flag: value,
            status: "pending",
            source: "agent",
            agentId,
            remoteId: null,
            message: null,
            createdAt: now,
            updatedAt: now,
          })
          .run()
      }
      return { status: "pending", verified: false }
    }

    // Platform challenge with remote verification.
    // Undefined only if the binding vanished mid-request; the try/catch below
    // owns that failure path.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const adapter = adapterForEvent(challenge.eventId) as CtfPlatformAdapter
    const persist = (
      result: SubmissionResult,
      status: ChallengeFlag["status"]
    ) => {
      // Re-lookup every write: the row may exist from an earlier persist in
      // this call (async judge: pending → polled verdict) or from a sibling
      // agent racing the same flag. A terminal verdict is never downgraded.
      const row = lookup(challengeId, value) ?? existing
      if (
        row &&
        (row.status === "accepted" || row.status === "rejected") &&
        status !== "accepted" &&
        status !== "rejected"
      ) {
        return
      }
      const now = new Date().toISOString()
      const patch = {
        status,
        source: "agent" as const,
        agentId,
        remoteId: result.remoteId ?? row?.remoteId ?? null,
        message: result.message ?? null,
        updatedAt: now,
      }
      if (row) {
        db.update(challengeFlags)
          .set(patch)
          .where(eq(challengeFlags.id, row.id))
          .run()
      } else {
        db.insert(challengeFlags)
          .values({
            id: crypto.randomUUID(),
            challengeId,
            flag: value,
            createdAt: now,
            ...patch,
          })
          .run()
      }
    }

    try {
      let result =
        existing?.status === "pending" &&
        existing.remoteId &&
        adapter.getSubmission
          ? await adapter.getSubmission(
              remote!.remoteId,
              existing.remoteId,
              signal
            )
          : await adapter.submitFlag(remote!.remoteId, value, signal)
      persist(result, flagStatusFromResult(result.status))
      for (
        let attempt = 0;
        result.status === "pending" && attempt < SUBMISSION_POLL_MAX_ATTEMPTS;
        attempt += 1
      ) {
        if (!result.remoteId || !adapter.getSubmission) break
        await sleep(SUBMISSION_POLL_INTERVAL_MS, undefined, { signal })
        result = await adapter.getSubmission(
          remote!.remoteId,
          result.remoteId,
          signal
        )
        persist(result, flagStatusFromResult(result.status))
      }
      if (result.status === "accepted" || result.status === "already_solved") {
        // Judged aside from this submission's own row (persist may have
        // landed above): a sibling racing another value may have flipped the
        // challenge already — their acceptance fires "first", this one lands
        // as "extra" (light notice), never a second cleanup round.
        const outcome: FlagAcceptOutcome = fullySolvedAsideFromFlag(
          db,
          challengeId,
          value
        )
          ? "extra"
          : "first"
        db.update(challengeRemote)
          .set({ solved: true })
          .where(eq(challengeRemote.challengeId, challengeId))
          .run()
        options?.onAgentFlagAccepted?.(challengeId, agentId, outcome)
      }
      if (result.status === "partial") {
        options?.onAgentFlagPartial?.(
          challengeId,
          result.message ?? null,
          agentId
        )
      }
      return {
        status: flagStatusFromResult(result.status),
        ...(result.message ? { message: result.message } : {}),
        ...(result.remoteId ? { remoteId: result.remoteId } : {}),
        verified: true,
      }
    } catch (error) {
      persist(
        { status: "error", message: submissionErrorMessage(error) },
        "error"
      )
      throw platformError(error)
    }
  }

  return { submitFlag, listFlags, addManualFlag, deleteFlag }
}

function submissionErrorMessage(error: unknown) {
  return error instanceof PlatformActionError || error instanceof PlatformError
    ? error.message
    : "Platform request failed"
}
