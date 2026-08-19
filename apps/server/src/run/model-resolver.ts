import {
  formatModelRef,
  get,
  resolveModelRef,
  type FlatSettings,
  type ModelRef,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"

import { RunActionError } from "./errors"

/** A resolved per-agent model snapshot: what the run factory persists on the
 * agent row (the concrete ref) plus the display fields that feed the
 * per-agent prompt context's `model` variable. */
export type SlotModel = {
  /** Canonical model ref string (`aegisx-<providerId>/<modelId>:<effort>`). */
  ref: ModelRef
  thinkingLevel: ThinkingLevel
  /** Display: provider label, model label, pi model id (prompt `model` var). */
  providerLabel: string
  modelLabel: string
  modelId: string
}

/** Everything the model resolver reads from the service: the flat settings
 * (default model) and the enabled provider connections. */
export type ModelResolverDeps = {
  getSettings(): FlatSettings
  providers(): ProviderConnection[]
}

export type ModelResolver = ReturnType<typeof createModelResolver>

/** Model-ref resolution, isolated from the service so both the run service
 * and (potentially) the routes share one implementation. All functions are
 * pure reads over the deps; nothing here touches the DB or the lifecycle. */
export function createModelResolver(deps: ModelResolverDeps) {
  /** The global default model ref string (setting `agent.defaultModelRef`), or
   * null when unset. */
  function defaultModelRef(): ModelRef | null {
    const ref = get(deps.getSettings(), "agent.defaultModelRef")
    return typeof ref === "string" && ref.length > 0 ? ref : null
  }

  /** Resolve a model ref to a concrete enabled provider+model+effort, or null
   * when it is empty / malformed / the referenced model is unavailable. */
  function resolveModelTarget(ref: ModelRef | null | undefined) {
    return resolveModelRef(ref, deps.providers())
  }

  /** Resolve a model ref to a CONCRETE {@link SlotModel} snapshot. Throws
   * when nothing resolves. */
  function resolveSlotModelFromRef(
    ref: ModelRef | null | undefined
  ): SlotModel {
    const target = resolveModelTarget(ref)
    if (!target) {
      throw new RunActionError(
        "invalid_state",
        ref
          ? `Configured model "${ref}" is unavailable`
          : "No enabled default model is configured"
      )
    }
    return {
      ref: formatModelRef(target.provider, target.model, target.thinkingLevel),
      thinkingLevel: target.thinkingLevel,
      providerLabel: target.provider.label,
      modelLabel: target.model.label,
      modelId: target.model.modelId,
    }
  }

  return {
    defaultModelRef,
    resolveModelTarget,
    resolveSlotModelFromRef,
  }
}
