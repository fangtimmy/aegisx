import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { modelProviderKey } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { Api, Model } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { generateModelsJson } from "../providers/models-json"

export type RunModelRuntime = ModelRuntime

/**
 * Build a per-run, isolated pi SDK ModelRuntime from the configured AegisX
 * providers. Reuses the proven models.json generator (which carries literal
 * apiKeys) by writing it to the run's runtime dir and pointing ModelRuntime at
 * it. No network catalog fetch.
 */
export async function createRunModelRuntime(options: {
  runtimeDir: string
  providers: ProviderConnection[]
  /** Loopback origin of this server — exact-endpoint gateway providers
   * route their models.json baseUrl through /api/llm-relay here. */
  relayOrigin: string
}): Promise<RunModelRuntime> {
  mkdirSync(options.runtimeDir, { recursive: true })
  const modelsPath = join(options.runtimeDir, "models.json")
  const authPath = join(options.runtimeDir, "auth.json")
  writeFileSync(
    modelsPath,
    `${JSON.stringify(
      generateModelsJson(options.providers, options.relayOrigin),
      null,
      2
    )}\n`
  )
  // apiKey is authoritative in models.json (single-user; no redaction).
  writeFileSync(authPath, "{}\n")
  return ModelRuntime.create({
    modelsPath,
    authPath,
    allowModelNetwork: false,
  })
}

/** Regenerate models.json from the current providers and hot-reload an
 * existing workspace ModelRuntime. The refresh half of the workspace
 * runtime lifecycle (build = {@link createRunModelRuntime}); used at
 * prepare/switch boundaries so a cached runtime picks up provider/apiKey/
 * metadata edits without a server restart. */
export async function refreshRunModelRuntime(
  runtime: RunModelRuntime,
  options: {
    runtimeDir: string
    providers: ProviderConnection[]
    /** Loopback origin of this server (see {@link createRunModelRuntime}). */
    relayOrigin: string
  }
): Promise<void> {
  mkdirSync(options.runtimeDir, { recursive: true })
  writeFileSync(
    join(options.runtimeDir, "models.json"),
    `${JSON.stringify(
      generateModelsJson(options.providers, options.relayOrigin),
      null,
      2
    )}\n`
  )
  await runtime.refresh({ allowNetwork: false })
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
): Model<Api> | undefined {
  const model = provider.models.find(
    (m) => m.id === modelId || m.modelId === modelId
  )
  if (!model) return undefined
  return modelRuntime.getModel(modelProviderKey(provider), model.modelId)
}
