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

export type AgentPromptIdentity = {
  name: string
  task: string | null
  isMain: boolean
}

export function createPromptContextBuilder(options: {
  db: Database
  dataDir: string
  getContainerWorkspace(): string
}) {
  const { db, dataDir } = options

  function buildPromptContext(
    runId: string,
    challenge: Challenge,
    remote: ChallengeRemote | undefined,
    challengeAttachments: PromptAttachment[],
    environment: EnvironmentConfig,
    modelConfig: ModelConfig,
    agent: AgentPromptIdentity
  ): PromptTemplateContext {
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
        role: agent.isMain ? "main" : "child",
        isMain: agent.isMain,
        name: agent.name,
        task: agent.task,
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
        provider: modelConfig.providerLabel ?? modelConfig.provider,
        name: modelConfig.modelLabel ?? modelConfig.modelId,
        id: modelConfig.modelId,
      },
      run: {
        id: runId,
        environment: environment.type,
        isContainer: environment.type === "container",
        workspace:
          environment.type === "container"
            ? options.getContainerWorkspace()
            : "$WORKSPACE",
        targetSupported,
        platformIntegrated,
        containerImage:
          environment.type === "container" ? environment.image : null,
        cpus: environment.type === "container" ? environment.cpus : null,
        memoryMb:
          environment.type === "container" ? environment.memoryMb : null,
        pidsLimit:
          environment.type === "container" ? environment.pidsLimit : null,
      },
      capabilities: {
        canFinishRun: agent.isMain,
        canSpawnAgent: agent.isMain,
        canSubmitFlag: agent.isMain && platformIntegrated,
        canManageTarget: agent.isMain && targetSupported,
      },
    }
  }

  function promptContextForAgent(
    context: PromptTemplateContext,
    agent: AgentPromptIdentity
  ): PromptTemplateContext {
    return {
      ...context,
      agent: {
        role: agent.isMain ? "main" : "child",
        isMain: agent.isMain,
        name: agent.name,
        task: agent.task,
      },
      capabilities: {
        canFinishRun: agent.isMain,
        canSpawnAgent: agent.isMain,
        canSubmitFlag: agent.isMain && context.run.platformIntegrated,
        canManageTarget: agent.isMain && context.run.targetSupported,
      },
    }
  }

  function attachmentFiles(challengeId: string) {
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

  function copyAttachments(
    challengeId: string,
    workspacePath: string
  ): PromptAttachment[] {
    return attachmentFiles(challengeId).map(({ storageKey, ...attachment }) => {
      copyFileSync(
        join(dataDir, "attachments", ...storageKey.split("/")),
        join(workspacePath, attachment.path)
      )
      return attachment
    })
  }

  return {
    buildPromptContext,
    promptContextForAgent,
    attachmentFiles,
    copyAttachments,
  }
}

export type PromptContextBuilder = ReturnType<typeof createPromptContextBuilder>
