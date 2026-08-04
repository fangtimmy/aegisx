import { Hono } from "hono"
import { get } from "../../shared"
import { createDatabase } from "./db"
import { createCatalogReader } from "./events/catalog"
import { registerEventRoutes } from "./events/routes"
import { createConfigStore } from "./infrastructure/config-store"
import { createStorage } from "./infrastructure/storage"
import { registerOrchestratorRoutes } from "./orchestrator/routes"
import { createOrchestratorService } from "./orchestrator/service"
import { registerPlatformRoutes } from "./platforms/routes"
import { createPlatformService } from "./platforms/service"
import { registerProviderRoutes } from "./providers/routes"
import { createContainerManager } from "./run/container/container-manager"
import { registerRunRoutes } from "./run/routes"
import { createRunService } from "./run/service"
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
  const runService = createRunService({
    db,
    dataDir: options.dataDir,
    containerManager,
    platformService,
    configStore,
    getSettings,
  })

  // Flag writes are a side path (platform → DB); refresh the run view after.
  platformService.setRunHooks({
    onRunFlagAccepted: (runId) => {
      runService.refresh(runId)
      runService.notifyFlagAccepted(runId)
    },
  })

  const orchestratorService = createOrchestratorService({
    db,
    dataDir: options.dataDir,
    containerManager,
    runService,
    getSettings,
    configStore,
  })
  runService.setOrchestratorNotifier((eventId, message) =>
    orchestratorService.notify(eventId, message)
  )
  void orchestratorService.recoverOnBoot().catch((error) => {
    console.error("Orchestrator boot recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  void runService.recoverOnBoot().catch((error) => {
    console.error("Boot recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  const app = new Hono()
  const catalog = createCatalogReader(db, platformService)

  app.onError((error, c) => {
    console.error("Request failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json(
      { error: { code: "internal_error", message: "Request failed" } },
      500
    )
  })

  app.get("/", (c) => c.json({ name: "AegisX", status: "ok", version: 4 }))

  // syncModels is a v2 artifact (pi-ai registry); kept as a no-op so the
  // provider/settings routes persist config without a live model registry.
  const noopSync = () => {}
  registerProviderRoutes(app, { configStore, syncModels: noopSync })
  registerSettingsRoutes(app, {
    configStore,
    syncModels: noopSync,
  })
  registerPlatformRoutes(app, platformService)
  registerEventRoutes(app, {
    db,
    storage,
    platformService,
    runManager: {
      listForEvent: (eventId: string) => runService.listForEvent(eventId),
    },
    getSettings,
    catalog,
  })
  registerRunRoutes(app, {
    db,
    dataDir: options.dataDir,
    runService,
    getSettings,
    configStore,
  })
  registerOrchestratorRoutes(app, { orchestratorService })

  app.get("/api/platform/status", (c) => c.json({ available: true }))

  return {
    app,
    close: async () => {
      await runService.close()
      await orchestratorService.close()
      sqlite.close()
      releaseLock()
    },
  }
}
