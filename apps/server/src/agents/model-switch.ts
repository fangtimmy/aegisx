import type { ProviderConnection } from "@aegisx/shared/provider"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { resolveRunModel } from "../run/model-runtime"

export type SwitchTarget = {
  provider: ProviderConnection
  model: ProviderConnection["models"][number]
  sdkModel: Model<Api>
}

/**
 * Resolve + validate a runtime model-switch target against a LIVE session's own
 * `ModelRuntime` (the SDK exposes it via `session.modelRuntime`). `modelId` is
 * the `ProviderModel.id` (UUID). Throws on not-found / unavailable (disabled
 * provider or model, or missing API key) — callers map that to an action error.
 *
 * Reusing the live session's runtime (rather than rebuilding one) means no new
 * lifecycle state and no per-run retention: the runtime is alive as long as the
 * session is.
 */
export function resolveSwitchTarget(
  modelRuntime: ModelRuntime,
  providers: ProviderConnection[],
  modelId: string
): SwitchTarget {
  for (const provider of providers) {
    const model = provider.models.find((m) => m.id === modelId)
    if (!model) continue
    if (!model.enabled || !provider.enabled || !provider.apiKey)
      throw new Error("Model is unavailable")
    const sdkModel = resolveRunModel(modelRuntime, provider, model.id)
    if (!sdkModel) throw new Error("Could not resolve the selected model")
    return { provider, model, sdkModel }
  }
  throw new Error("Model not found")
}
