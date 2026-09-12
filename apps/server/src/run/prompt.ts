import { copyFileSync, mkdirSync } from "node:fs"
import { basename, extname, join } from "node:path"

import type {
  EnvironmentConfig,
  ModelConfig,
  PromptAttachment,
} from "@aegisx/shared"
import { eventBriefFor, parseEventPromptBrief } from "@aegisx/shared"
import { and, asc, eq } from "drizzle-orm"

import type { Database } from "../db"
import {
  attachments,
  challengeFlags,
  type challenges,
  eventPlatforms,
  events,
} from "../db/schema"
import type { PromptContext } from "../orchestration/types"
import {
  type ChallengeRemote,
  isPlatformIntegrated,
} from "../platforms/challenge-state"
import { RunStartError } from "./errors"
import { agentId8 } from "./workspace-resolver"

type Challenge = typeof challenges.$inferSelect

export type SolverPromptInputs = {
  challenge: Challenge
  remote: ChallengeRemote | undefined
  challengeAttachments: PromptAttachment[]
  environment: EnvironmentConfig
  model: ModelConfig
  agentId: string
  containerWorkspace: string
  /** This attempt's hard deadline (spawn spec or the default); rendered into
   * the initial prompt as `timeoutMinutes`. */
  timeoutMs: number
}

/**
 * Build the spawn-time {@link PromptContext} for a solver agent. The
 * workspace block describes the derived path tree: the agent's own directory
 * (`agents/<id8>` — its bash cwd + host file-tool root), the server-written
 * read-only `shared/` area, the one-shot `attachments/` materialization, and
 * the sibling agent directories. `capabilities` are NOT set here — the
 * factory injects the tool-list-derived values for every render (single
 * source of truth).
 */
export function buildSolverPromptContext(
  inputs: SolverPromptInputs,
  db: Database
): PromptContext {
  const {
    challenge,
    remote,
    challengeAttachments,
    environment,
    model,
    agentId,
    containerWorkspace,
    timeoutMs,
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
  const platformIntegrated = isPlatformIntegrated(remote)
  // Live multi-flag progress: the stored description's count is a sync-time
  // snapshot; the accepted-flag rows are the truth at spawn time.
  const confirmedFlags = db
    .select({ flag: challengeFlags.flag })
    .from(challengeFlags)
    .where(
      and(
        eq(challengeFlags.challengeId, challenge.id),
        eq(challengeFlags.status, "accepted")
      )
    )
    .orderBy(asc(challengeFlags.createdAt), asc(challengeFlags.id))
    .all()
    .map((row) => row.flag)
  const brief = parseEventPromptBrief(event.promptBrief)
  return {
    event: {
      id: event.id,
      name: event.name,
      platform: platform?.type ?? null,
      brief: eventBriefFor("solver", brief),
      flagFormats: brief.flagFormats,
    },
    challenge: {
      id: challenge.id,
      name: challenge.name,
      description: challenge.description,
      category: challenge.category,
      points: challenge.points,
      integrated: platformIntegrated,
      attachments: challengeAttachments,
      attachmentPaths: challengeAttachments.map(({ path }) => path),
      confirmedFlags,
    },
    timeoutMinutes: Math.max(1, Math.round(timeoutMs / 60_000)),
    model: {
      provider: model.providerLabel ?? model.provider,
      name: model.modelLabel ?? model.modelId,
      id: model.modelId,
    },
    workspace: {
      root: containerWorkspace,
      agentDir: `agents/${agentId8(agentId)}`,
      sharedDir: "shared",
      attachmentsDir: "attachments",
      siblingsDir: "agents",
      containerImage: environment.image,
      cpus: environment.cpus,
      memoryMb: environment.memoryMb,
      pidsLimit: environment.pidsLimit,
    },
  }
}

/**
 * Build the {@link PromptContext} for the scheduler (orchestrator) agent. No
 * `challenge` block — the scheduler manages the event, not one challenge;
 * `workspace` carries only the root it works at. No `capabilities` — the
 * scheduler's abilities come from its tool list (empty after the SDK
 * convergence), injected by the factory like every other agent.
 */
export function buildSchedulerPromptContext(
  inputs: {
    eventId: string
    instruction: string
    model: ModelConfig
    /** The scheduler workspace root as seen inside its container. */
    containerWorkspace: string
  },
  db: Database
): PromptContext {
  const { eventId, instruction, model } = inputs
  const event = db.select().from(events).where(eq(events.id, eventId)).get()
  if (!event) throw new RunStartError("Event is unavailable")
  const platform = db
    .select({ type: eventPlatforms.type })
    .from(eventPlatforms)
    .where(eq(eventPlatforms.eventId, event.id))
    .get()
  const brief = parseEventPromptBrief(event.promptBrief)
  return {
    event: {
      id: event.id,
      name: event.name,
      platform: platform?.type ?? null,
      brief: eventBriefFor("orchestrator", brief),
      flagFormats: brief.flagFormats,
    },
    model: {
      provider: model.providerLabel ?? model.provider,
      name: model.modelLabel ?? model.modelId,
      id: model.modelId,
    },
    workspace: {
      root: inputs.containerWorkspace,
    },
    // The scheduler does not solve challenges — no flag/target context.
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

/** Materialize the challenge's attachments into the workspace's
 * `attachments/` dir (overwrite semantics — naturally idempotent, so
 * re-spawns on the same workspace do not duplicate copies). */
export function copyAttachments(
  db: Database,
  dataDir: string,
  challengeId: string,
  workspacePath: string
): PromptAttachment[] {
  const files = attachmentFiles(db, challengeId)
  if (files.length === 0) return []
  mkdirSync(join(workspacePath, "attachments"), { recursive: true })
  return files.map(({ storageKey, ...attachment }) => {
    copyFileSync(
      join(dataDir, "attachments", ...storageKey.split("/")),
      join(workspacePath, "attachments", attachment.path)
    )
    return attachment
  })
}
