import { copyFileSync } from "node:fs"
import { basename, extname, join } from "node:path"

import type {
  EnvironmentConfig,
  ModelConfig,
  PromptAttachment,
} from "@aegisx/shared"
import { eq } from "drizzle-orm"

import type { Database } from "../db"
import {
  attachments,
  type challenges,
  eventPlatforms,
  events,
} from "../db/schema"
import type { PromptContext } from "../orchestration/types"
import {
  type ChallengeRemote,
  isPlatformIntegrated,
  isTargetCapable,
} from "../platforms/challenge-state"
import { RunStartError } from "./errors"

type Challenge = typeof challenges.$inferSelect

export type RunPromptInputs = {
  runId: string
  challenge: Challenge
  remote: ChallengeRemote | undefined
  challengeAttachments: PromptAttachment[]
  environment: EnvironmentConfig
  model: ModelConfig
  /** v9: true when the run has more than one solver — feeds
   * `run.multiSolver` (renders the co-solver section in mainSystem). */
  multiSolver: boolean
}

/**
 * Build the run-level {@link PromptContext} for a challenge-scoped run
 * (scope-aware). `agent` and per-agent `capabilities` are intentionally
 * LEFT BLANK here — `agent` is filled per-agent by `createAgent`, and
 * `capabilities` is the RUN-LEVEL view (challenge-derived) used to render
 * `initialPrompt`. createAgent OVERRIDES `capabilities` with the value derived
 * from each agent's own tool list when rendering that agent's system prompt.
 * For classic (single solver) the two coincide, so the rendered initial prompt
 * advertises exactly the solver's abilities.
 */
export function buildPromptContext(
  inputs: RunPromptInputs,
  db: Database,
  containerWorkspace: string
): PromptContext {
  const {
    runId,
    challenge,
    remote,
    challengeAttachments,
    environment,
    model,
    multiSolver,
  } = inputs
  const event = db
    .select()
    .from(events)
    .where(eq(events.id, challenge.eventId))
    .get()
  if (!event) throw new RunStartError("Event is unavailable")
  const platform = db
    .select({ type: eventPlatforms.type })
    .from(eventPlatforms)
    .where(eq(eventPlatforms.eventId, event.id))
    .get()
  const targetSupported = isTargetCapable(remote)
  const platformIntegrated = isPlatformIntegrated(remote)
  return {
    event: {
      id: event.id,
      name: event.name,
      platform: platform?.type ?? null,
      promptHint: event.promptHint ?? "",
    },
    challenge: {
      id: challenge.id,
      name: challenge.name,
      description: challenge.description,
      category: challenge.category,
      points: challenge.points,
      attachments: challengeAttachments,
      attachmentPaths: challengeAttachments.map(({ path }) => path),
    },
    model: {
      provider: model.providerLabel ?? model.provider,
      name: model.modelLabel ?? model.modelId,
      id: model.modelId,
    },
    run: {
      id: runId,
      environment: "container",
      isContainer: true,
      workspace: containerWorkspace,
      targetSupported,
      platformIntegrated,
      containerImage: environment.image,
      cpus: environment.cpus,
      memoryMb: environment.memoryMb,
      pidsLimit: environment.pidsLimit,
      multiSolver,
    },
    capabilities: {
      canFinish: true,
      canSubmitFlag: platformIntegrated,
      canManageTarget: targetSupported,
    },
  }
}

/**
 * Build the run-level {@link PromptContext} for an event-scoped (scheduler)
 * run. No `challenge` block — the scheduler manages an event, not
 * one challenge — and no `capabilities` (the scheduler's abilities come from
 * its own tool list via createAgent). `instruction` carries the user's
 * strategic direction for the event.
 */
export function buildEventPromptContext(
  inputs: {
    runId: string
    eventId: string
    instruction: string
    environment: EnvironmentConfig
    model: ModelConfig
  },
  db: Database,
  containerWorkspace: string
): PromptContext {
  const { runId, eventId, instruction, environment, model } = inputs
  const event = db.select().from(events).where(eq(events.id, eventId)).get()
  if (!event) throw new RunStartError("Event is unavailable")
  const platform = db
    .select({ type: eventPlatforms.type })
    .from(eventPlatforms)
    .where(eq(eventPlatforms.eventId, event.id))
    .get()
  return {
    event: {
      id: event.id,
      name: event.name,
      platform: platform?.type ?? null,
      promptHint: event.promptHint ?? "",
    },
    model: {
      provider: model.providerLabel ?? model.provider,
      name: model.modelLabel ?? model.modelId,
      id: model.modelId,
    },
    run: {
      id: runId,
      environment: "container",
      isContainer: true,
      workspace: containerWorkspace,
      // The scheduler run does not solve challenges — no flag/target context.
      targetSupported: false,
      platformIntegrated: false,
      containerImage: environment.image,
      cpus: environment.cpus,
      memoryMb: environment.memoryMb,
      pidsLimit: environment.pidsLimit,
      multiSolver: false,
    },
    instruction,
  }
}

function attachmentFiles(db: Database, challengeId: string) {
  const rows = db
    .select()
    .from(attachments)
    .where(eq(attachments.challengeId, challengeId))
    .orderBy(attachments.createdAt, attachments.id)
    .all()
  const used = new Set<string>()
  return rows.map((attachment) => {
    const original = basename(attachment.originalName) || "attachment"
    const extension = extname(original)
    const stem = original.slice(0, original.length - extension.length)
    let filename = original
    for (let suffix = 2; used.has(filename); suffix += 1) {
      filename = `${stem} (${suffix})${extension}`
    }
    used.add(filename)
    return {
      name: attachment.originalName,
      path: filename,
      size: attachment.size,
      storageKey: attachment.storageKey,
    }
  })
}

export function copyAttachments(
  db: Database,
  dataDir: string,
  challengeId: string,
  workspacePath: string
): PromptAttachment[] {
  return attachmentFiles(db, challengeId).map(
    ({ storageKey, ...attachment }) => {
      copyFileSync(
        join(dataDir, "attachments", ...storageKey.split("/")),
        join(workspacePath, attachment.path)
      )
      return attachment
    }
  )
}
