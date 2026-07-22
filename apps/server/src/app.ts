import type { Api, Model, MutableModels } from "@earendil-works/pi-ai"
import { Hono } from "hono"
import { createDatabase } from "./db"
import { createCatalogReader } from "./events/catalog"
import { registerEventRoutes } from "./events/routes"
import { createConfigStore } from "./infrastructure/config-store"
import { redactSecrets } from "./infrastructure/redaction"
import { createStorage } from "./infrastructure/storage"
import { registerPlatformRoutes } from "./platforms/routes"
import { createPlatformService } from "./platforms/service"
import { createModelService } from "./providers/models"
import { providerName, registerProviderRoutes } from "./providers/routes"
import { createRunManager } from "./runs/manager"
import { registerRunRoutes } from "./runs/routes"
import { resolvePromptTemplates } from "./settings/prompt-templates"
import { registerSettingsRoutes } from "./settings/routes"

export function createApp(options: {
  dataDir: string
  maxConcurrency?: number
  models?: MutableModels
  resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined
}) {
  const configStore = createConfigStore(options.dataDir)
  const { db, sqlite, releaseLock } = createDatabase(options.dataDir)
  const storage = createStorage(options.dataDir)
  const modelService = createModelService(
    configStore,
    options.models,
    options.resolveModel
  )
  const providerSecrets = new Map<string, Set<string>>()
  const syncModels = () => {
    const activeProviders = configStore.getProviders().map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled),
    }))
    for (const { provider, models } of activeProviders) {
      if (!provider.enabled || !provider.apiKey || models.length === 0) continue
      const name = providerName(provider.id)
      const secrets = providerSecrets.get(name) ?? new Set<string>()
      secrets.add(provider.apiKey)
      providerSecrets.set(name, secrets)
    }
    modelService.sync()
  }
  syncModels()
  const getSettings = () => configStore.getSettings()
  const platformService = createPlatformService(
    db,
    storage,
    () => getSettings().maxAttachmentMb * 1024 * 1024,
    configStore
  )
  const initialSettings = getSettings()
  const environmentConcurrency = process.env.AEGISX_MAX_CONCURRENCY
    ? Number(process.env.AEGISX_MAX_CONCURRENCY)
    : undefined
  const configuredConcurrency =
    options.maxConcurrency ??
    environmentConcurrency ??
    initialSettings.maxConcurrency
  const runManager = createRunManager({
    db,
    dataDir: options.dataDir,
    maxConcurrency:
      Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency
        : 2,
    getApiKeys: (provider) => providerSecrets.get(provider) ?? [],
    getPromptTemplates: () => resolvePromptTemplates(getSettings()),
    getSettings,
    modelService,
    canFinishRun: platformService.canFinishRun,
    submitFlag: platformService.submitFlag,
    targetAction: platformService.targetAction,
  })
  const app = new Hono()

  const catalog = createCatalogReader(db, platformService)

  app.onError((error, c) => {
    const secrets = [...providerSecrets.values()].flatMap((values) => [
      ...values,
    ])
    console.error("Request failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
        secrets
      ),
    })
    return c.json(
      { error: { code: "internal_error", message: "Request failed" } },
      500
    )
  })

  app.get("/", (c) => c.json({ name: "AegisX", status: "ok" }))

  registerProviderRoutes(app, {
    configStore,
    syncModels,
  })
  registerSettingsRoutes(app, {
    configStore,
    setMaxConcurrency: runManager.setMaxConcurrency,
    syncModels,
  })
  registerPlatformRoutes(app, platformService)
  registerEventRoutes(app, {
    db,
    storage,
    platformService,
    runManager,
    getSettings,
    catalog,
  })
  registerRunRoutes(app, {
    db,
    runManager,
    getSettings,
    configStore,
    catalog,
  })

  app.get("/api/platform/status", (c) => c.json({ available: true }))

  return {
    app,
    activeSessionCount: runManager.activeSessionCount,
    close: async () => {
      await runManager.close()
      sqlite.close()
      releaseLock()
    },
  }
}
