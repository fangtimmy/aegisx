import { copyFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { eq } from "drizzle-orm"
import type {
  EnvironmentConfig,
  ModelConfig,
  PromptAttachment,
  PromptTemplateContext,
} from "../../../shared"
import type { createDatabase } from "../db"
import {
  attachments,
  type challenges,
  eventPlatforms,
  events,
} from "../db/schema"
import {
  type ChallengeRemote,
  isPlatformIntegrated,
  isTargetCapable,
} from "../platforms/challenge-state"
import { RunStartError } from "./errors"

type Database = ReturnType<typeof createDatabase>["db"]
type Challenge = typeof challenges.$inferSelect

export type RunPromptInputs = {
  runId: string
  challenge: Challenge
  remote: ChallengeRemote | undefined
  challengeAttachments: PromptAttachment[]
  environment: EnvironmentConfig
  model: ModelConfig
}

/**
 * Build the handlebars PromptTemplateContext for a run.
 * v4: host-side pi SDK. The main agent can spawn children; capabilities mirror
 * the native tools registered for the run.
 */
export function buildPromptContext(
  inputs: RunPromptInputs,
  db: Database,
  containerWorkspace: string
): PromptTemplateContext {
  const { runId, challenge, remote, challengeAttachments, environment, model } =
    inputs
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
    agent: {
      role: "main",
      isMain: true,
      name: "Main agent",
      task: null,
    },
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
    },
    capabilities: {
      canFinishRun: true,
      canSpawnAgent: true,
      canSubmitFlag: platformIntegrated,
      canManageTarget: targetSupported,
    },
  }
}

export function attachmentFiles(db: Database, challengeId: string) {
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
