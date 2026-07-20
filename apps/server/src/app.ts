import type { Api, Model, MutableModels } from "@earendil-works/pi-ai"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { createDatabase } from "./db"
import { providerConnections, providerModels, settings } from "./db/schema"
import { createCatalogReader } from "./events/catalog"
import { registerEventRoutes } from "./events/routes"
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
  const { db, sqlite, releaseLock } = createDatabase(options.dataDir)
  const storage = createStorage(options.dataDir)
  const modelService = createModelService(
    db,
    options.models,
    options.resolveModel
  )
  const providerSecrets = new Map<string, Set<string>>()
  const listProviderModels = (providerId: string) =>
    db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, providerId))
      .all()
  const syncModels = () => {
    const activeProviders = db
      .select()
      .from(providerConnections)
      .all()
      .map((provider) => ({
        provider,
        models: listProviderModels(provider.id).filter(
          (model) => model.enabled
        ),
      }))
      .filter(
        ({ provider, models }) =>
          provider.enabled && Boolean(provider.apiKey) && models.length > 0
      )
    for (const { provider } of activeProviders) {
      const name = providerName(provider.id)
      const secrets = providerSecrets.get(name) ?? new Set<string>()
      secrets.add(provider.apiKey)
      providerSecrets.set(name, secrets)
    }
    modelService.sync()
  }
  if (!db.select().from(settings).where(eq(settings.id, 1)).get()) {
    const now = new Date().toISOString()
    db.insert(providerConnections)
      .values({
        id: "default-provider",
        label: "Anthropic",
        type: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "",
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(providerModels)
      .values({
        id: "default-model",
        providerId: "default-provider",
        modelId: "claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(settings)
      .values({ id: 1, defaultModelId: "default-model", updatedAt: now })
      .run()
  }
  const getSettings = () => {
    const value = db.select().from(settings).where(eq(settings.id, 1)).get()
    if (!value) throw new Error("Settings are unavailable")
    return value
  }
  const platformService = createPlatformService(
    db,
    storage,
    () => getSettings().maxAttachmentMb * 1024 * 1024
  )
  syncModels()
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
    db,
    getSettings,
    listProviderModels,
    syncModels,
  })
  registerSettingsRoutes(app, {
    db,
    getSettings,
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
