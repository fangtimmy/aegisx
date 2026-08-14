import { resolveModelRef } from "@aegisx/shared"
import type { ModelRef } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { resolveRunModel } from "../run/model-runtime"

export type SwitchTarget = {
  provider: ProviderConnection
  model: ProviderConnection["models"][number]
  thinkingLevel: ThinkingLevel
  sdkModel: Model<Api>
}

/**
 * Resolve + validate a runtime model-switch target against a LIVE session's own
 * `ModelRuntime` (the SDK exposes it via `session.modelRuntime`). `ref` is a
 * canonical model ref string (`<providerKey>/<modelId>:<effort>` or
 * `alias:<id>`); aliases resolve to the first currently-available model +
 * their reasoning level. Throws on not-found / unavailable — callers map that
 * to an action error.
 *
 * Reusing the live session's runtime (rather than rebuilding one) means no new
 * lifecycle state and no per-run retention: the runtime is alive as long as the
 * session is. The chosen model is snapshotted (as a concrete ref) onto the
 * agent row, so later alias edits do not retro-switch a running agent.
 */
export function resolveSwitchTarget(
  modelRuntime: ModelRuntime,
  providers: ProviderConnection[],
  aliases: Parameters<typeof resolveModelRef>[2],
  ref: ModelRef
): SwitchTarget {
  const target = resolveModelRef(ref, providers, aliases)
  if (!target) throw new Error("Model not found or unavailable")
  const sdkModel = resolveRunModel(
    modelRuntime,
    target.provider,
    target.model.id
  )
  if (!sdkModel) throw new Error("Could not resolve the selected model")
  return {
    provider: target.provider,
    model: target.model,
    thinkingLevel: target.thinkingLevel,
    sdkModel,
  }
}
