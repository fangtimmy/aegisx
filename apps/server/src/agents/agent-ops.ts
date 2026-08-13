import type { ModelAlias, SwitchModelInput } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/provider"
import type { ThinkingLevel } from "@aegisx/shared/thinking"

import type { HostAgentSession } from "./host-session"
import { resolveSwitchTarget } from "./model-switch"

/** Re-exported so services import all model-switch concerns from here. */
export type { SwitchTarget } from "./model-switch"
import type { SwitchTarget } from "./model-switch"

/**
 * Apply a live model (and optionally thinking-level) switch to a host session,
 * factoring out the mechanics shared by the run and orchestrator services:
 * resolve the target against the live session's own runtime, skip `setModel`
 * when the model is unchanged (avoids a spurious model_change marker), and
 * apply the optional thinking level.
 *
 * Returns the resolved target + the session's resulting thinking level. The
 * caller owns error wrapping (its bespoke action-error type) and persistence
 * (each service stores a different id shape on its row).
 *
 * `isUnchanged` lets each service compare against its own stored id: the run
 * row stores the underlying `modelId` string, the orchestrator row stores the
 * `ProviderModel.id` UUID.
 */
export async function applyModelSwitch(
  host: HostAgentSession,
  providers: ProviderConnection[],
  aliases: ModelAlias[],
  input: SwitchModelInput,
  isUnchanged: (target: SwitchTarget) => boolean
): Promise<{ target: SwitchTarget; thinkingLevel: ThinkingLevel }> {
  const target = resolveSwitchTarget(
    host.session.modelRuntime,
    providers,
    aliases,
    input.modelId
  )
  if (!isUnchanged(target)) await host.session.setModel(target.sdkModel)
  if (input.thinkingLevel) host.session.setThinkingLevel(input.thinkingLevel)
  return { target, thinkingLevel: host.session.thinkingLevel }
}
