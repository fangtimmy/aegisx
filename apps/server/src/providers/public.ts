import type { ProviderType } from "@aegisx/shared/platform"
import type { ProviderConnection, ProviderModel } from "@aegisx/shared/provider"

import type { ConfigStore, ProviderData } from "../infrastructure/config-store"
import { parseModelMetadata, supportedThinkingLevels } from "./builtin-models"

export function mapProviderModel(
  model: ProviderData["models"][number],
  providerId: string
): ProviderModel {
  const metadata = parseModelMetadata(model.metadata)
  return {
    id: model.id,
    providerId,
    modelId: model.modelId,
    label: model.label,
    enabled: model.enabled,
    metadata,
    piBinding:
      model.piProviderId && model.piModelId
        ? { providerId: model.piProviderId, modelId: model.piModelId }
        : null,
    thinkingLevels: supportedThinkingLevels(metadata),
    createdAt: "",
    updatedAt: "",
  }
}

export function mapProviderConnection(
  provider: ProviderData
): ProviderConnection {
  return {
    id: provider.id,
    label: provider.label,
    type: provider.type as ProviderType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    enabled: provider.enabled,
    createdAt: "",
    updatedAt: "",
    models: provider.models.map((model) =>
      mapProviderModel(model, provider.id)
    ),
  }
}

/** All configured providers in the shared ProviderConnection shape. */
export function getProviderConnections(
  configStore: ConfigStore
): ProviderConnection[] {
  return configStore.getProviders().map(mapProviderConnection)
}
