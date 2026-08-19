import { get } from "@aegisx/shared"
import { Hono } from "hono"

import { registerActivityRoutes } from "./activity/routes"
import { createDatabase } from "./db"
import { SCHEMA_VERSION } from "./db/schema"
import { createCatalogReader } from "./events/catalog"
import { registerEventRoutes } from "./events/routes"
import { createConfigStore } from "./infrastructure/config-store"
import { createStorage } from "./infrastructure/storage"
import { registerPlatformRoutes } from "./platforms/routes"
import { createPlatformService } from "./platforms/service"
import { registerProviderRoutes } from "./providers/routes"
import { createContainerManager } from "./run/container/container-manager"
import { registerRunRoutes } from "./run/routes"
import { createAgentService } from "./run/service"
import { registerSchedulerRoutes } from "./scheduler/routes"
import { registerSettingsRoutes } from "./settings/routes"

export function createApp(options: { dataDir: string }) {
  const configStore = createConfigStore(options.dataDir)
  const { db, sqlite, releaseLock } = createDatabase(options.dataDir)

  const storage = createStorage(options.dataDir)
  const getSettings = () => configStore.getSettings()

  const platformService = createPlatformService(
    db,
    storage,
    () => get(getSettings(), "runtime.maxAttachmentMb") * 1024 * 1024,
    configStore
  )

  const containerManager = createContainerManager()
  const agentService = createAgentService({
    db,
    dataDir: options.dataDir,
    containerManager,
    platformService,
    configStore,
    getSettings,
  })

  // Flag writes are a side path (platform → DB); refresh the submitting
  // agent's view and notify the event's scheduler. A full solve additionally
  // stops the challenge's other live agents; a multi-flag partial steers
  // them (partial carries the platform's progress message).
  platformService.setAgentHooks({
    onAgentFlagAccepted: (challengeId, agentId) => {
      if (agentId) agentService.refresh(agentId)
      agentService.notifyFlagAccepted(challengeId, agentId)
    },
    onAgentFlagPartial: (challengeId, message, agentId) => {
      if (agentId) agentService.refresh(agentId)
      agentService.notifyFlagPartial(challengeId, message, agentId)
    },
  })

  void agentService.recoverOnBoot().catch((error: unknown) => {
    console.error("Boot recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  const app = new Hono()
  const catalog = createCatalogReader(db, platformService)

  app.onError((error, c) => {
    console.error("Request failed", {
      method: c.req.method,
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json(
      { error: { code: "internal_error", message: "Request failed" } },
      500
    )
  })

  app.get("/", (c) =>
    c.json({ name: "AegisX", status: "ok", version: SCHEMA_VERSION })
  )

  // syncModels is a v2 artifact (pi-ai registry). Kept as a no-op: model
  // runtime sync is lazy — a live run's ModelRuntime is refreshed on demand
  // when a model switch targets a provider/model added after the run started
  // (service.refreshRunModelRuntime). Provider/settings writes only persist
  // config here.
  const noopSync = () => {}
  registerProviderRoutes(app, { configStore })
  registerSettingsRoutes(app, {
    db,
    configStore,
    syncModels: noopSync,
  })
  registerPlatformRoutes(app, platformService)
  registerEventRoutes(app, {
    db,
    storage,
    platformService,
    agentManager: {
      usageForEvent: (eventId: string) => agentService.usageForEvent(eventId),
      deleteAgentsForEvent: (eventId: string, scope: "solver" | "all") =>
        agentService.deleteAgentsForEvent(eventId, scope),
    },
    getSettings,
    catalog,
    cleanupChallengeChannels: (challengeId: string) =>
      agentService.channels.cleanupChallengeChannels(challengeId),
    deleteChallengeWorkspace: (eventId, challengeId) =>
      agentService.deleteChallengeWorkspace(eventId, challengeId),
    cleanupEventChannels: (eventId: string) =>
      agentService.channels.cleanupEventChannels(eventId),
    deleteEventWorkspaces: (eventId: string) =>
      agentService.deleteEventWorkspaces(eventId),
  })
  registerRunRoutes(app, {
    db,
    agentService,
  })
  registerSchedulerRoutes(app, { db, agentService })
  registerActivityRoutes(app, { db })

  app.get("/api/platform/status", (c) => c.json({ available: true }))

  return {
    app,
    close: async () => {
      await agentService.close()
      sqlite.close()
      releaseLock()
    },
  }
}
