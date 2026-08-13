import { resolveModelTarget } from "@aegisx/shared"
import type { ModelAlias } from "@aegisx/shared"
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
 * either a `ProviderModel.id` (UUID) or an `alias:<id>` reference (resolved to
 * the first currently-available model in the alias). Throws on not-found /
 * unavailable (disabled provider or model, or missing API key) — callers map
 * that to an action error.
 *
 * Reusing the live session's runtime (rather than rebuilding one) means no new
 * lifecycle state and no per-run retention: the runtime is alive as long as the
 * session is. The chosen model is snapshotted onto the agent row, so later
 * alias edits do not retro-switch a running agent.
 */
export function resolveSwitchTarget(
  modelRuntime: ModelRuntime,
  providers: ProviderConnection[],
  aliases: ModelAlias[],
  modelId: string
): SwitchTarget {
  // Pre-resolve alias refs to a concrete enabled ProviderModel.id.
  const concreteId =
    resolveModelTarget(
      modelId,
      (id) => {
        for (const provider of providers) {
          const model = provider.models.find((m) => m.id === id)
          if (model) return model
        }
        return undefined
      },
      aliases
    )?.id ?? modelId

  for (const provider of providers) {
    const model = provider.models.find((m) => m.id === concreteId)
    if (!model) continue
    if (!model.enabled || !provider.enabled || !provider.apiKey)
      throw new Error("Model is unavailable")
    const sdkModel = resolveRunModel(modelRuntime, provider, model.id)
    if (!sdkModel) throw new Error("Could not resolve the selected model")
    return { provider, model, sdkModel }
  }
  throw new Error("Model not found")
}
