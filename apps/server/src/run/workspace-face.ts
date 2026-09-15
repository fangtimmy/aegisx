import { rmSync } from "node:fs"

import type { WorkspaceFile } from "@aegisx/shared"
import { eq } from "drizzle-orm"

import type { Database } from "../db"
import { challenges } from "../db/schema"
import {
  readWorkspacePath,
  workspaceDownload,
} from "../infrastructure/workspace-files"
import type { ContainerManager } from "./container/container-manager"
import type { AgentKernel } from "./kernel"
import {
  challengeCacheVolume,
  challengeRoot,
  orchestratorRoot,
  workspaceDir as workspaceDirOf,
} from "./workspace-resolver"

export type WorkspaceFaceDeps = {
  db: Database
  dataDir: string
  containerManager: ContainerManager
  /** Workspace-runtime eviction routes through the kernel (its cache). */
  kernel: Pick<AgentKernel, "forgetWorkspace">
}

/**
 * The workspace file face (L4): the challenge/orchestrator workspace trees
 * as files — listing/download for the routes and the deletion sweeps for
 * the event/challenge teardowns. Pure file + volume plumbing around the
 * derived paths; anything agent-live belongs to the kernel.
 */
export function createWorkspaceFace(deps: WorkspaceFaceDeps) {
  const { db, dataDir, containerManager, kernel } = deps

  /** Host root of a challenge's workspace tree. */
  function challengeWorkspaceRoot(
    eventId: string,
    challengeId: string
  ): string {
    return workspaceDirOf(challengeRoot(dataDir, eventId, challengeId))
  }

  /** Challenge workspace file tree (agents/ shared/ attachments/ visible). */
  function workspaceFiles(
    eventId: string,
    challengeId: string,
    path: string
  ): WorkspaceFile {
    return readWorkspacePath(challengeWorkspaceRoot(eventId, challengeId), path)
  }

  function workspaceDownloadPath(
    eventId: string,
    challengeId: string,
    path: string
  ) {
    return workspaceDownload(challengeWorkspaceRoot(eventId, challengeId), path)
  }

  /** Remove a challenge's workspace tree (agents/ shared/ attachments/
   * sessions/ runtime/) + its cache volume — called on challenge deletion.
   * The deletion routes refuse while live agents exist on the challenge, so
   * evicting the cached workspace context alongside the tree is safe (the
   * last agent's settle already destroyed its sandbox). */
  function deleteChallengeWorkspace(
    eventId: string,
    challengeId: string
  ): void {
    kernel.forgetWorkspace({ eventId, challengeId })
    void containerManager
      .removeVolume(challengeCacheVolume(challengeId))
      .catch(() => undefined)
    rmSync(challengeRoot(dataDir, eventId, challengeId), {
      recursive: true,
      force: true,
    })
  }

  /** Remove the orchestrator workspace tree — called on event deletion. */
  function deleteSchedulerWorkspace(eventId: string): void {
    kernel.forgetWorkspace({ eventId, challengeId: null })
    rmSync(orchestratorRoot(dataDir, eventId), {
      recursive: true,
      force: true,
    })
  }

  /** Remove every challenge workspace + the orchestrator workspace of the
   * event on event deletion. Idempotent per directory. */
  function deleteEventWorkspaces(eventId: string): void {
    const challengeRows = db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.eventId, eventId))
      .all()
    for (const { id } of challengeRows) {
      deleteChallengeWorkspace(eventId, id)
    }
    deleteSchedulerWorkspace(eventId)
  }

  return {
    challengeWorkspaceRoot,
    workspaceFiles,
    workspaceDownloadPath,
    deleteChallengeWorkspace,
    deleteSchedulerWorkspace,
    deleteEventWorkspaces,
  }
}
