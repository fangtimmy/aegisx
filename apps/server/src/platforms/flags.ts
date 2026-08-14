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
import { getChallengeRemote, isPlatformIntegrated } from "./challenge-state"
import {
  type CtfPlatformAdapter,
  PlatformError,
  type SubmissionResult,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

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

function toPublic(row: typeof challengeFlags.$inferSelect): ChallengeFlag {
  return {
    id: row.id,
    challengeId: row.challengeId,
    flag: row.flag,
    status: row.status as ChallengeFlag["status"],
    source: row.source as ChallengeFlag["source"],
    runId: row.runId,
    remoteId: row.remoteId,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

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
    /** Notify the run layer after a flag becomes platform-accepted (SSE refresh). */
    onRunFlagAccepted?(runId: string): void
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
      .map(toPublic)
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
        ...toPublic(existing),
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
      runId: null,
      remoteId: null,
      message: null,
      createdAt: now,
      updatedAt: now,
    }
    db.insert(challengeFlags).values(row).run()
    return toPublic({ ...row })
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
    runId: string,
    challengeId: string,
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
      // submitting run — the scheduler's run.flagAccepted must fire for it.
      if (existing.status === "accepted") options?.onRunFlagAccepted?.(runId)
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
      const now = new Date().toISOString()
      const row = {
        id: existing?.id ?? crypto.randomUUID(),
        challengeId,
        flag: value,
        status: "accepted" as const,
        source: "run" as const,
        runId,
        remoteId: null,
        message: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (existing) {
        db.update(challengeFlags)
          .set({ status: "accepted", source: "run", runId, updatedAt: now })
          .where(eq(challengeFlags.id, existing.id))
          .run()
      } else {
        db.insert(challengeFlags).values(row).run()
      }
      // No remote judge here, but the acceptance is real — notify the run
      // layer so the scheduler learns the flag (spec §3.5 run.flagAccepted).
      options?.onRunFlagAccepted?.(runId)
      return { status: "accepted", verified: false }
    }

    // Platform challenge, but verification explicitly skipped: store as pending.
    if (!verifyRemote) {
      const now = new Date().toISOString()
      if (existing) {
        db.update(challengeFlags)
          .set({ status: "pending", source: "run", runId, updatedAt: now })
          .where(eq(challengeFlags.id, existing.id))
          .run()
      } else {
        db.insert(challengeFlags)
          .values({
            id: crypto.randomUUID(),
            challengeId,
            flag: value,
            status: "pending",
            source: "run",
            runId,
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
    const adapter = adapterForEvent(challenge.eventId) as CtfPlatformAdapter
    const persist = (
      result: SubmissionResult,
      status: ChallengeFlag["status"]
    ) => {
      const now = new Date().toISOString()
      const patch = {
        status,
        source: "run" as const,
        runId,
        remoteId: result.remoteId ?? existing?.remoteId ?? null,
        message: result.message ?? null,
        updatedAt: now,
      }
      if (existing) {
        db.update(challengeFlags)
          .set(patch)
          .where(eq(challengeFlags.id, existing.id))
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
        db.update(challengeRemote)
          .set({ solved: true })
          .where(eq(challengeRemote.challengeId, challengeId))
          .run()
        options?.onRunFlagAccepted?.(runId)
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
