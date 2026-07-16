import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type Models,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { eq } from "drizzle-orm"
import type { createDatabase } from "./db"
import { providerConnections, providerModels } from "./db/schema"

type Database = ReturnType<typeof createDatabase>["db"]

const providerName = (id: string) => `aegisx-${id}`

const providerApi = (
  type: string
): "openai-completions" | "openai-responses" | "anthropic-messages" =>
  type === "openai-compatible"
    ? "openai-completions"
    : type === "openai-responses"
      ? "openai-responses"
      : "anthropic-messages"

const streams: Record<
  "openai-completions" | "openai-responses" | "anthropic-messages",
  ProviderStreams
> = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
}

export function createModelService(
  db: Database,
  collection: MutableModels = createModels(),
  resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined
) {
  const registered = new Set<string>()

  function sync() {
    const providers = db.select().from(providerConnections).all()
    const active = new Set<string>()
    for (const provider of providers) {
      const models = db
        .select()
        .from(providerModels)
        .where(eq(providerModels.providerId, provider.id))
        .all()
        .filter((model) => model.enabled)
      if (!provider.enabled || !provider.apiKey || models.length === 0) continue

      const id = providerName(provider.id)
      const api = providerApi(provider.type)
      active.add(id)
      collection.setProvider(
        createProvider({
          id,
          name: provider.label,
          baseUrl: provider.baseUrl,
          auth: {
            apiKey: {
              name: `${provider.label} API key`,
              resolve: async () => {
                const current = db
                  .select()
                  .from(providerConnections)
                  .where(eq(providerConnections.id, provider.id))
                  .get()
                return current?.enabled && current.apiKey
                  ? {
                      auth: { apiKey: current.apiKey },
                      source: "AegisX provider settings",
                    }
                  : undefined
              },
            },
          },
          models: models.map(
            (model): Model<Api> => ({
              id: model.modelId,
              name: model.label,
              api,
              provider: id,
              baseUrl: provider.baseUrl,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
            })
          ),
          api: streams[api],
        })
      )
      registered.add(id)
    }
    for (const id of registered) {
      if (!active.has(id)) {
        collection.deleteProvider(id)
        registered.delete(id)
      }
    }
  }

  return {
    models: collection as Models,
    sync,
    find: (provider: string, modelId: string) =>
      resolveModel?.(provider, modelId) ??
      collection.getModel(provider, modelId),
  }
}

export type ModelService = ReturnType<typeof createModelService>
