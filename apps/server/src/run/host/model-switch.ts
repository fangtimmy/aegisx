import { formatModelRef, parseModelRef, resolveModelRef } from "@aegisx/shared"
import type { ModelRef } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { resolveRunModel } from "../model-runtime"

export type SwitchTarget = {
  provider: ProviderConnection
  model: ProviderConnection["models"][number]
  thinkingLevel: ThinkingLevel
  sdkModel: Model<Api>
}

/**
 * Resolve + validate a runtime model-switch target against a LIVE session's own
 * `ModelRuntime` (the SDK exposes it via `session.modelRuntime`). `ref` is a
 * canonical model ref string (`<providerKey>/<modelId>:<effort>`). Throws on
 * not-found / unavailable — callers map that to an action error.
 *
 * Reusing the live session's runtime (rather than rebuilding one) means no new
 * lifecycle state and no per-run retention: the runtime is alive as long as the
 * session is. The chosen model is snapshotted (as a concrete ref) onto the
 * agent row, so later provider edits do not retro-switch a running agent.
 * (A model added while the run is live is missing from the runtime snapshot;
 * the service lazy-refreshes the runtime and retries once before surfacing.)
 */
export function resolveSwitchTarget(
  modelRuntime: ModelRuntime,
  providers: ProviderConnection[],
  ref: ModelRef
): SwitchTarget {
  const target = resolveModelRef(ref, providers)
  if (!target) {
    if (!parseModelRef(ref)) {
      throw new Error(`Invalid model ref "${ref}"`)
    }
    throw new Error(
      `Model "${ref}" is unavailable (provider disabled, missing apiKey, or model disabled)`
    )
  }
  const sdkModel = resolveRunModel(
    modelRuntime,
    target.provider,
    target.model.id
  )
  if (!sdkModel) {
    throw new Error(
      `Model "${formatModelRef(
        target.provider,
        target.model,
        target.thinkingLevel
      )}" is not available in the run's model runtime — check the provider's apiKey`
    )
  }
  return {
    provider: target.provider,
    model: target.model,
    thinkingLevel: target.thinkingLevel,
    sdkModel,
  }
}
