import { setTimeout as sleep } from "node:timers/promises"
import { and, desc, eq, inArray } from "drizzle-orm"
import type { createDatabase } from "../db"
import {
  challenges,
  type eventPlatforms,
  runs,
  submissions,
} from "../db/schema"
import {
  type CtfPlatformAdapter,
  PlatformError,
  type SubmissionResult,
} from "./core"
import { PlatformActionError, platformError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type StoredPlatform = typeof eventPlatforms.$inferSelect

export function createPlatformSubmissions(
  db: Database,
  storedPlatform: (eventId: string) => StoredPlatform | undefined,
  adapterForEvent: (eventId: string) => CtfPlatformAdapter | undefined
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
    if (
      !challenge?.remoteId ||
      !challenge.remoteAvailable ||
      !platform ||
      challenge.remoteSourceKey !== platform.sourceKey
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
              challenge.remoteId,
              submission.remoteId,
              signal
            )
          : await adapter.submitFlag(challenge.remoteId, value, signal)
      persist(result)
      for (
        let attempt = 0;
        result.status === "pending" && attempt < 60;
        attempt += 1
      ) {
        if (!result.remoteId || !adapter.getSubmission) break
        await sleep(1000, undefined, { signal })
        result = await adapter.getSubmission(
          challenge.remoteId,
          result.remoteId,
          signal
        )
        persist(result)
      }
      if (result.status === "accepted" || result.status === "already_solved") {
        db.transaction((tx) => {
          tx.update(challenges)
            .set({ remoteSolved: true, updatedAt: new Date().toISOString() })
            .where(eq(challenges.id, challengeId))
            .run()
          tx.update(runs).set({ flag: value }).where(eq(runs.id, runId)).run()
        })
      }
      return result
    } catch (error) {
      persist({ status: "error", message: submissionErrorMessage(error) })
      throw platformError(error)
    }
  }

  function canFinishRun(runId: string, challengeId: string) {
    const challenge = db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get()
    if (
      !challenge?.remoteId ||
      !challenge.remoteAvailable ||
      challenge.remoteSolved
    ) {
      return true
    }
    return Boolean(
      db
        .select({ id: submissions.id })
        .from(submissions)
        .innerJoin(runs, eq(submissions.runId, runs.id))
        .where(
          and(
            eq(submissions.runId, runId),
            eq(runs.challengeId, challengeId),
            inArray(submissions.status, ["accepted", "already_solved"])
          )
        )
        .get()
    )
  }

  return { canFinishRun, submitFlag }
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
