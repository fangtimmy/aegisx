import type { ProviderConnection, ProviderModel } from "./domain"
import { isThinkingLevel, type ThinkingLevel } from "./domain"

/**
 * Model reference — the single canonical way to point at "one model + one
 * reasoning effort" across the whole system (settings, run-creation inputs, DB
 * snapshots, model-switch API, UI pickers).
 *
 * `"<providerKey>/<modelId>:<effort>"` — the providerKey is always
 * `aegisx-<providerId>` (see {@link modelProviderKey}), so a ref is stable
 * across provider/model *label* renames and metadata re-imports, and it is
 * exactly the address pi addresses the model with inside a run.
 */
export type ModelRef = string

/** Minimal structural view of a provider/model pair for ref formatting. Keeps
 * the helpers generic over the full {@link ProviderConnection}/{@link ProviderModel}
 * types and their storage shapes alike. */
type ProviderLike = Pick<ProviderConnection, "id">
type ModelLike = Pick<ProviderModel, "modelId">

/** pi provider key for a configured provider: `aegisx-<providerId>`. */
export function modelProviderKey(provider: ProviderLike): string {
  return `aegisx-${provider.id}`
}

/** `"<providerKey>/<modelId>"` address (no effort suffix). */
export function modelAddress(provider: ProviderLike, model: ModelLike): string {
  return `${modelProviderKey(provider)}/${model.modelId}`
}

/** Format a concrete model ref string from a provider/model pair + effort. */
export function formatModelRef(
  provider: ProviderLike,
  model: ModelLike,
  effort: ThinkingLevel
): ModelRef {
  return `${modelAddress(provider, model)}:${effort}`
}

export type ParsedModelRef = {
  kind: "model"
  providerKey: string
  modelId: string
  effort: ThinkingLevel
}

/** Parse a model ref string. Returns null for a malformed/unrecognized string.
 * The address is split on the first `/` and the effort on the last `:` (only
 * when the suffix is a known thinking level — model ids never collide with
 * the level names). */
export function parseModelRef(
  ref: string | null | undefined
): ParsedModelRef | null {
  if (!ref) return null
  const colon = ref.lastIndexOf(":")
  if (colon > 0) {
    const maybeEffort = ref.slice(colon + 1)
    if (isThinkingLevel(maybeEffort)) {
      const parsed = parseAddress(ref.slice(0, colon))
      if (parsed) return { ...parsed, effort: maybeEffort }
      return null
    }
  }
  // No (valid) effort suffix → effort defaults to off.
  const parsed = parseAddress(ref)
  return parsed ? { ...parsed, effort: "off" } : null
}

function parseAddress(
  address: string
): { kind: "model"; providerKey: string; modelId: string } | null {
  const slash = address.indexOf("/")
  if (slash <= 0 || slash === address.length - 1) return null
  return {
    kind: "model",
    providerKey: address.slice(0, slash),
    modelId: address.slice(slash + 1),
  }
}

export type ResolvedModelTarget<M = ProviderModel> = {
  provider: ProviderConnection
  model: M
  thinkingLevel: ThinkingLevel
}

/**
 * Resolve a model ref to a concrete (provider, model, effort) triple against
 * the currently-configured providers. Returns null when the ref is empty,
 * malformed, or the referenced model is unavailable (provider disabled /
 * missing apiKey / model disabled).
 *
 * Pure (shared) — takes only the public provider shapes, so both server
 * (run create / cold-restore / model-switch) and tests can use it. The caller
 * turns the resolved provider+model into an SDK model via its ModelRuntime.
 */
function isEnabledProvider(provider: ProviderConnection): boolean {
  return provider.enabled && !!provider.apiKey
}

export function resolveModelRef<M extends ProviderModel>(
  ref: ModelRef | null | undefined,
  providers: ProviderConnection[]
): ResolvedModelTarget<M> | null {
  const parsed = parseModelRef(ref)
  if (!parsed) return null

  for (const provider of providers) {
    if (!isEnabledProvider(provider)) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      if (
        modelAddress(provider, model) ===
        `${parsed.providerKey}/${parsed.modelId}`
      ) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 泛型收窄边界：M 由调用方按地址契约声明，运行时仅能按地址匹配。
        return { provider, model: model as M, thinkingLevel: parsed.effort }
      }
    }
  }
  return null
}

/**
 * Body for a runtime model switch (run entry agent + per-agent + event
 * orchestrator). `model` is a canonical model ref string
 * (`<providerKey>/<modelId>:<effort>`) — the resolved provider
 * + model + effort are snapshotted onto the agent row, and the SDK model is
 * swapped on the live session. Both are persisted by the SDK as
 * `model_change` / `thinking_level_change` session entries, so the switch is
 * visible in the timeline.
 */
export type SwitchModelInput = {
  model: ModelRef
}
