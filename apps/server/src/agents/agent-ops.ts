import { modelAddress, parseModelRef } from "@aegisx/shared"
import type { ModelAlias, ModelRef } from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"

import type { HostAgentSession } from "./host-session"
import { resolveSwitchTarget } from "./model-switch"

/** Re-exported so services import all model-switch concerns from here. */
export type { SwitchTarget } from "./model-switch"
import type { SwitchTarget } from "./model-switch"

/** Extract the pi address (`<providerKey>/<modelId>`) of a stored ref, or "" if
 * it is not a concrete model ref. Used to detect an effort-only switch (same
 * model address) so the SDK `setModel` marker is skipped. */
function refAddress(ref: ModelRef | null | undefined): string {
  const parsed = parseModelRef(ref)
  return parsed?.kind === "model"
    ? `${parsed.providerKey}/${parsed.modelId}`
    : ""
}

/**
 * Apply a live model switch to a host session: resolve the ref against the live
 * session's own runtime, skip `setModel` when only the reasoning level changes
 * (avoids a spurious model_change marker), and apply the new thinking level.
 *
 * `currentRef` is the agent row's currently-stored concrete ref, used for the
 * unchanged-model check. Returns the resolved target + resulting thinking
 * level. The caller owns error wrapping + persistence (it writes the concrete
 * ref string to its row).
 */
export async function applyModelSwitch(
  host: HostAgentSession,
  providers: ProviderConnection[],
  aliases: ModelAlias[],
  ref: ModelRef,
  currentRef: ModelRef | null
): Promise<{ target: SwitchTarget; thinkingLevel: ThinkingLevel }> {
  const target = resolveSwitchTarget(
    host.session.modelRuntime,
    providers,
    aliases,
    ref
  )
  if (refAddress(currentRef) !== modelAddress(target.provider, target.model)) {
    await host.session.setModel(target.sdkModel)
  }
  host.session.setThinkingLevel(target.thinkingLevel)
  return { target, thinkingLevel: target.thinkingLevel }
}
