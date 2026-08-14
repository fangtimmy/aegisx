import {
  formatModelRef,
  get,
  parseModelRef,
  resolveModelRef,
  type FlatSettings,
  type ModelAlias,
  type ModelRef,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"

import type { AgentModels } from "../infrastructure/config-store"
import type { SlotModel } from "../orchestration/types"
import { RunActionError } from "./errors"
import type { RunModelDisplay } from "./public"

/** Everything the model resolver reads from the service: the flat settings
 * (default model), the enabled provider connections, alias table and per-slot
 * orchestration model overrides. */
export type ModelResolverDeps = {
  getSettings(): FlatSettings
  providers(): ProviderConnection[]
  getAliases(): ModelAlias[]
  getAgentModels(): AgentModels
}

export type ModelResolver = ReturnType<typeof createModelResolver>

/** Model-ref resolution, isolated from the service so both the run service
 * and (potentially) the routes share one implementation. All functions are
 * pure reads over the deps; nothing here touches the DB or the lifecycle. */
export function createModelResolver(deps: ModelResolverDeps) {
  /** The global default model ref string (setting `agent.defaultModelId`), or
   * null when unset. May be a concrete `<key>/<id>:<effort>` or `alias:<id>`. */
  function defaultModelRef(): ModelRef | null {
    const ref = get(deps.getSettings(), "agent.defaultModelId")
    return typeof ref === "string" && ref.length > 0 ? ref : null
  }

  /** Resolve a model ref to a concrete enabled provider+model+effort, or null
   * when it is empty / malformed / every referenced model is unavailable. */
  function resolveModelTarget(ref: ModelRef | null | undefined) {
    return resolveModelRef(ref, deps.providers(), deps.getAliases())
  }

  /** Resolve a model ref to a CONCRETE {@link SlotModel} snapshot (aliases
   * resolved to the first available model so per-agent rows do not follow later
   * alias edits). Throws when nothing resolves. */
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

  /** Resolve a plugin slot's model from the orchestration settings, falling
   * back to the global default. */
  function resolveSlotModel(pluginId: string, slot: string): SlotModel {
    return resolveSlotModelFromRef(
      deps.getAgentModels()[pluginId]?.[slot] ?? defaultModelRef()
    )
  }

  /** Derive the run-level model display fields (provider/modelId/modelName/
   * thinkingLevel) for {@link toRunPublic} from a stored ref string. Falls back
   * to parsing the ref when no provider matches (e.g. provider since disabled). */
  function resolveModelDisplay(ref: ModelRef): RunModelDisplay {
    const target = resolveModelTarget(ref)
    if (target) {
      return {
        provider: target.provider.label,
        modelId: target.model.modelId,
        modelName: target.model.label,
        thinkingLevel: target.thinkingLevel,
      }
    }
    const parsed = parseModelRef(ref)
    if (parsed?.kind === "model") {
      return {
        provider: parsed.providerKey,
        modelId: parsed.modelId,
        modelName: parsed.modelId,
        thinkingLevel: parsed.effort,
      }
    }
    return { provider: "", modelId: "", modelName: ref, thinkingLevel: "off" }
  }

  return {
    defaultModelRef,
    resolveModelTarget,
    resolveSlotModelFromRef,
    resolveSlotModel,
    resolveModelDisplay,
  }
}
