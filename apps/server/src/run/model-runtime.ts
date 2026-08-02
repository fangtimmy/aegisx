import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ProviderConnection } from "../../../shared/provider"
import { generateModelsJson, resolvePiModelRef } from "../providers/models-json"

export type RunModelRuntime = ModelRuntime

/**
 * Build a per-run, isolated pi SDK ModelRuntime from the configured AegisX
 * providers. Reuses the proven models.json generator (which handles both
 * custom and piBinding models + literal apiKeys) by writing it to the run's
 * runtime dir and pointing ModelRuntime at it. No network catalog fetch.
 */
export async function createRunModelRuntime(options: {
  runtimeDir: string
  providers: ProviderConnection[]
}): Promise<RunModelRuntime> {
  mkdirSync(options.runtimeDir, { recursive: true })
  const modelsPath = join(options.runtimeDir, "models.json")
  const authPath = join(options.runtimeDir, "auth.json")
  writeFileSync(
    modelsPath,
    `${JSON.stringify(generateModelsJson(options.providers), null, 2)}\n`
  )
  // apiKey is authoritative in models.json (single-user; no redaction).
  writeFileSync(authPath, "{}\n")
  return ModelRuntime.create({
    modelsPath,
    authPath,
    allowModelNetwork: false,
  })
}

/** Resolve the SDK Model for a (provider, modelId) selection.
 *
 * `modelId` may be either the provider-model UUID `id` (as the create flow
 * receives from the API) or the underlying `modelId` string stored on the run
 * row (as cold-restore / ensureWarm receives). Match either so both paths
 * resolve the same model. */
export function resolveRunModel(
  modelRuntime: RunModelRuntime,
  provider: ProviderConnection,
  modelId: string
): Model<any> | undefined {
  const model = provider.models.find(
    (m) => m.id === modelId || m.modelId === modelId
  )
  if (!model) return undefined
  const { providerKey, modelId: piModelId } = resolvePiModelRef(provider, model)
  return modelRuntime.getModel(providerKey, piModelId)
}
