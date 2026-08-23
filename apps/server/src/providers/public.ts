import type { ProviderConnection, ProviderModel } from "@aegisx/shared/domain"

import type { ConfigStore, ProviderData } from "../infrastructure/config-store"
import { parseModelMetadata, supportedThinkingLevels } from "./builtin-models"

function mapProviderModel(
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
    metadataSource: model.metadataSource,
    thinkingLevels: supportedThinkingLevels(metadata),
  }
}

function mapProviderConnection(provider: ProviderData): ProviderConnection {
  return {
    id: provider.id,
    label: provider.label,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    enabled: provider.enabled,
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
