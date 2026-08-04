import { setTimeout as sleep } from "node:timers/promises"
import { and, desc, eq } from "drizzle-orm"
import type { createDatabase } from "../db"
import {
  challengeRemote,
  challenges,
  type eventPlatforms,
  runs,
  submissions,
} from "../db/schema"
import { getChallengeRemote, isPlatformIntegrated } from "./challenge-state"
import {
  type CtfPlatformAdapter,
  PlatformError,
  type SubmissionResult,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredPlatform = typeof eventPlatforms.$inferSelect

/** Async-judge polling cadence (a1ctf/ret2 return a judge id then resolve). */
const SUBMISSION_POLL_INTERVAL_MS = 1000
const SUBMISSION_POLL_MAX_ATTEMPTS = 60

export function createPlatformSubmissions(
  db: Database,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined,
  options?: {
    /** Notify run layer after DB flag/solved writes (SSE refresh). */
    onRunFlagAccepted?(runId: string): void
  }
) {
  async function submitFlag(
    runId: string,
    challengeId: string,
    flag?: string,
    signal?: AbortSignal
  ) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    const platform = challenge ? storedPlatform(challenge.eventId) : undefined
    const remote = challenge ? getChallengeRemote(db, challengeId) : undefined
    if (
      !challenge ||
      !isPlatformIntegrated(remote) ||
      !platform ||
      remote.sourceKey !== platform.sourceKey
    ) {
      return undefined
    }
    if (!flag?.trim()) {
      throw new PlatformActionError(
        "invalid_state",
        "A flag is required for a platform challenge"
      )
    }
    const adapter = adapterForEvent(challenge.eventId) as CtfPlatformAdapter
    const value = flag.trim()
    let submission = db
      .select()
      .from(submissions)
      .where(and(eq(submissions.runId, runId), eq(submissions.flag, value)))
      .orderBy(desc(submissions.updatedAt))
      .get()
    if (
      submission &&
      ["accepted", "already_solved", "rejected", "partial"].includes(
        submission.status
      )
    ) {
      return storedSubmissionResult(submission)
    }
    const now = new Date().toISOString()
    if (!submission) {
      submission = {
        id: crypto.randomUUID(),
        runId,
        flag: value,
        status: "pending",
        remoteId: null,
        message: null,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(submissions).values(submission).run()
    }
    const persist = (result: SubmissionResult) => {
      db.update(submissions)
        .set({
          status: result.status,
          remoteId: result.remoteId ?? submission.remoteId,
          message: result.message ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(submissions.id, submission.id))
        .run()
    }
    try {
      let result =
        submission.status === "pending" &&
        submission.remoteId &&
        adapter.getSubmission
          ? await adapter.getSubmission(
              remote.remoteId,
              submission.remoteId,
              signal
            )
          : await adapter.submitFlag(remote.remoteId, value, signal)
      persist(result)
      for (
        let attempt = 0;
        result.status === "pending" && attempt < SUBMISSION_POLL_MAX_ATTEMPTS;
        attempt += 1
      ) {
        if (!result.remoteId || !adapter.getSubmission) break
        await sleep(SUBMISSION_POLL_INTERVAL_MS, undefined, { signal })
        result = await adapter.getSubmission(
          remote.remoteId,
          result.remoteId,
          signal
        )
        persist(result)
      }
      if (result.status === "accepted" || result.status === "already_solved") {
        db.transaction((tx) => {
          tx.update(challengeRemote)
            .set({ solved: true })
            .where(eq(challengeRemote.challengeId, challengeId))
            .run()
          tx.update(runs).set({ flag: value }).where(eq(runs.id, runId)).run()
        })
        options?.onRunFlagAccepted?.(runId)
      }
      return result
    } catch (error) {
      persist({ status: "error", message: submissionErrorMessage(error) })
      throw platformError(error)
    }
  }

  return { submitFlag }
}

function storedSubmissionResult(
  submission: typeof submissions.$inferSelect
): SubmissionResult {
  return {
    status: submission.status as SubmissionResult["status"],
    ...(submission.remoteId ? { remoteId: submission.remoteId } : {}),
    ...(submission.message ? { message: submission.message } : {}),
  }
}

function submissionErrorMessage(error: unknown) {
  return error instanceof PlatformActionError || error instanceof PlatformError
    ? error.message
    : "Platform request failed"
}
