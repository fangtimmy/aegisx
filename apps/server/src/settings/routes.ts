import {
  isConfigDocumentV1,
  parseSettings,
  resolveModelRef,
} from "@aegisx/shared"
import { asc } from "drizzle-orm"
import type { Hono } from "hono"
import { Type } from "typebox"

import type { createDatabase } from "../db"
import { promptTemplates } from "../db/schema"
import type {
  ConfigStore,
  ProviderData,
  ProviderModelData,
} from "../infrastructure/config-store"
import { badRequest, notFound } from "../infrastructure/http-errors"
import { normalizeHttpBaseUrl } from "../infrastructure/urls"
import { validateJson } from "../infrastructure/validation"
import {
  DEFAULT_INITIAL_PROMPT_TEMPLATE,
  DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE,
} from "../orchestration/prompt-defaults"
import {
  ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES,
  PROMPT_TEMPLATE_VARIABLES,
  previewInitialPrompt,
  previewOrchestratorSystemPrompt,
  previewSystemPrompt,
  sampleOrchestratorPromptContext,
  samplePromptContext,
} from "../orchestration/prompt-templates"
import {
  normalizeModelMetadata,
  parseModelMetadata,
} from "../providers/builtin-models"
import { getProviderConnections } from "../providers/public"

const promptPreviewInput = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("mainSystemPrompt"),
      Type.Literal("initialPrompt"),
      Type.Literal("orchestratorSystemPrompt"),
    ]),
    template: Type.String({ maxLength: 100_000 }),
  },
  { additionalProperties: false }
)

/** PATCH /api/prompt-templates body: one (plugin, key) row upsert. */
const promptTemplateInput = Type.Object(
  {
    plugin: Type.String({ minLength: 1, maxLength: 80 }),
    key: Type.String({ minLength: 1, maxLength: 80 }),
    body: Type.String({ maxLength: 100_000 }),
  },
  { additionalProperties: false }
)

function settingsResponse(configStore: ConfigStore) {
  return {
    settings: configStore.getSettings(),
    updatedAt: configStore.getUpdatedAt(),
    meta: {
      promptTemplateDefaults: {
        mainSystem: DEFAULT_MAIN_SYSTEM_PROMPT_TEMPLATE,
        initial: DEFAULT_INITIAL_PROMPT_TEMPLATE,
        orchestratorSystem: DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT_TEMPLATE,
        schedulerInitial: DEFAULT_SCHEDULER_INITIAL_PROMPT_TEMPLATE,
      },
      promptVariables: [...PROMPT_TEMPLATE_VARIABLES],
      orchestratorPromptVariables: [...ORCHESTRATOR_PROMPT_TEMPLATE_VARIABLES],
    },
  }
}

export function registerSettingsRoutes(
  app: Hono,
  options: {
    db: ReturnType<typeof createDatabase>["db"]
    configStore: ConfigStore
    syncModels(): void
  }
) {
  const { db, configStore } = options
  // Reference through the options object (not destructured) so `this` survives.
  const syncModels = () => options.syncModels()
  const previewPrompt = (
    kind: "mainSystemPrompt" | "initialPrompt" | "orchestratorSystemPrompt",
    template: string
  ) => {
    if (kind === "mainSystemPrompt") {
      return previewSystemPrompt(template, samplePromptContext)
    }
    if (kind === "orchestratorSystemPrompt") {
      return previewOrchestratorSystemPrompt(
        template,
        sampleOrchestratorPromptContext
      )
    }
    return previewInitialPrompt(template, samplePromptContext)
  }

  const transferModel = (model: ProviderModelData) => ({
    id: model.id,
    modelId: model.modelId,
    label: model.label,
    enabled: model.enabled,
    metadata: parseModelMetadata(model.metadata),
    metadataSource: model.metadataSource,
  })

  const transferProviders = () =>
    configStore.getProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      enabled: provider.enabled,
      models: provider.models.map(transferModel),
    }))

  app.get("/api/settings", (c) => c.json(settingsResponse(configStore)))

  // Prompt template store: GET lists all rows (plugin-grouped by
  // the client), PATCH upserts one (plugin, key) row. Independent of
  // FlatSettings — the settings-page editor edits this store directly.
  app.get("/api/prompt-templates", (c) =>
    c.json({
      items: db
        .select()
        .from(promptTemplates)
        .orderBy(asc(promptTemplates.plugin), asc(promptTemplates.key))
        .all(),
    })
  )

  app.patch("/api/prompt-templates", validateJson(promptTemplateInput), (c) => {
    const input = c.req.valid("json")
    const updatedAt = new Date().toISOString()
    db.insert(promptTemplates)
      .values({
        plugin: input.plugin,
        key: input.key,
        body: input.body,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [promptTemplates.plugin, promptTemplates.key],
        set: { body: input.body, updatedAt },
      })
      .run()
    return c.json({
      items: db
        .select()
        .from(promptTemplates)
        .orderBy(asc(promptTemplates.plugin), asc(promptTemplates.key))
        .all(),
    })
  })

  app.get("/api/settings/export", () => {
    const content = JSON.stringify(
      {
        version: 1,
        settings: configStore.getSettings(),
        providers: transferProviders(),
      },
      null,
      2
    )
    return new Response(content, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "attachment; filename=aegisx-settings.json",
      },
    })
  })

  app.patch("/api/settings", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return badRequest(c, "invalid_json", "Request body must be JSON")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return badRequest(
        c,
        "invalid_settings",
        "Settings patch must be an object of flat keys"
      )
    }
    const patch = body as Record<string, unknown>
    if ("agent.defaultModelRef" in patch) {
      const modelRef = patch["agent.defaultModelRef"]
      if (modelRef !== null && modelRef !== undefined) {
        if (typeof modelRef !== "string" || modelRef.length === 0) {
          return badRequest(
            c,
            "invalid_settings",
            "Default model ref is invalid"
          )
        }
        // The default model is a canonical ref string (`aegisx-<pid>/<id>:<effort>`);
        // it must resolve to an enabled provider+model.
        const target = resolveModelRef(
          modelRef,
          getProviderConnections(configStore)
        )
        if (!target) {
          return notFound(c, "Default model not found")
        }
      }
    }
    configStore.updateSettings(patch)
    return c.json(settingsResponse(configStore))
  })

  app.post(
    "/api/settings/prompts/preview",
    validateJson(promptPreviewInput),
    (c) => {
      try {
        const input = c.req.valid("json")
        return c.json({ segments: previewPrompt(input.kind, input.template) })
      } catch (error) {
        return badRequest(
          c,
          "invalid_prompt_template",
          error instanceof Error ? error.message : "Prompt template is invalid"
        )
      }
    }
  )

  app.post("/api/settings/import", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return badRequest(c, "invalid_json", "Request body must be JSON")
    }
    if (!isConfigDocumentV1(body)) {
      return badRequest(
        c,
        "invalid_settings_import",
        "Unsupported settings file (expected version 1)"
      )
    }
    try {
      const settings = parseSettings(body.settings)
      const providerIds = new Set<string>()
      const modelIds = new Set<string>()
      const providerModelIds = new Set<string>()
      const newProviders: ProviderData[] = []
      for (const raw of body.providers) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("Invalid provider entry")
        }
        const provider = raw as Record<string, unknown>
        if (typeof provider.id !== "string" || !provider.id) {
          throw new Error("Provider id is required")
        }
        if (providerIds.has(provider.id))
          throw new Error("Duplicate provider ID")
        providerIds.add(provider.id)
        if (typeof provider.label !== "string" || !provider.label.trim()) {
          throw new Error("Provider name is required")
        }
        if (
          provider.type !== "openai-compatible" &&
          provider.type !== "openai-responses" &&
          provider.type !== "anthropic-messages"
        ) {
          throw new Error("Invalid provider type")
        }
        if (typeof provider.baseUrl !== "string") {
          throw new Error("Provider endpoint is required")
        }
        const baseUrl = normalizeHttpBaseUrl(provider.baseUrl)
        const modelsRaw = Array.isArray(provider.models) ? provider.models : []
        const models: ProviderModelData[] = []
        for (const rawModel of modelsRaw) {
          if (
            !rawModel ||
            typeof rawModel !== "object" ||
            Array.isArray(rawModel)
          ) {
            throw new Error("Invalid model entry")
          }
          const model = rawModel as Record<string, unknown>
          if (typeof model.id !== "string" || !model.id) {
            throw new Error("Model id is required")
          }
          if (modelIds.has(model.id)) throw new Error("Duplicate model ID")
          modelIds.add(model.id)
          if (typeof model.modelId !== "string" || !model.modelId.trim()) {
            throw new Error("Model ID and name are required")
          }
          if (typeof model.label !== "string" || !model.label.trim()) {
            throw new Error("Model ID and name are required")
          }
          const providerModelKey = `${provider.id}\u0000${model.modelId.trim()}`
          if (providerModelIds.has(providerModelKey)) {
            throw new Error("Duplicate model ID for provider")
          }
          providerModelIds.add(providerModelKey)
          const metadataSource =
            typeof model.metadataSource === "string"
              ? model.metadataSource
              : null
          models.push({
            id: model.id,
            modelId: model.modelId.trim(),
            label: model.label.trim(),
            enabled: model.enabled !== false,
            metadata: JSON.stringify(
              normalizeModelMetadata(
                model.metadata ?? {
                  reasoning: model.reasoning ?? false,
                  thinkingLevelMap: model.thinkingLevelMap ?? {},
                }
              )
            ),
            metadataSource,
          })
        }
        newProviders.push({
          id: provider.id,
          label: provider.label.trim(),
          type: provider.type,
          baseUrl,
          apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
          enabled: provider.enabled !== false,
          models,
        })
      }
      // Concrete default-model refs (`<key>/<id>:<effort>`) are validated at
      // use time against the imported providers; importing cannot cheaply
      // rebuild the aegisx-* provider keys.
      configStore.replaceAll(settings, newProviders)
      syncModels()
      return c.json({
        version: 1,
        settings: configStore.getSettings(),
        providers: transferProviders(),
      })
    } catch (error) {
      return badRequest(
        c,
        "invalid_settings_import",
        error instanceof Error ? error.message : "Settings import failed"
      )
    }
  })
}
