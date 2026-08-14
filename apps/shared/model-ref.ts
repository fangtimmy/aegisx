import { isAliasRef, refAliasId } from "./alias"
import type { ProviderConnection, ProviderModel } from "./provider"
import { isThinkingLevel, type ThinkingLevel } from "./thinking"

/**
 * Model reference — the single canonical way to point at "one model + one
 * reasoning effort" across the whole system (config, plugin slots, DB
 * snapshots, model-switch API, UI pickers). Replaces the former
 * `{ provider, modelId, thinking }` object and the mixed UUID/label refs.
 *
 * Two forms:
 *  - concrete: `"<providerKey>/<modelId>:<effort>"`, e.g.
 *    `"openai/gpt-4o:high"` (a pi-bound model) or
 *    `"aegisx-<providerId>/<modelId>:medium"` (a fully custom provider).
 *    `<providerKey>/<modelId>` is exactly what pi addresses the model with
 *    (see {@link modelProviderKey} / {@link piModelIdOf}), so a concrete ref is
 *    stable across provider/model *label* renames.
 *  - alias: `"alias:<id>"` — a named pointer to an ordered model list + a
 *    reasoning level (resolved to the first currently-available model). The
 *    effort comes from the alias, not the string.
 */
export type ModelRef = string

/** Minimal structural view of a provider/model pair for ref formatting. Keeps
 * the helpers generic over the full {@link ProviderConnection}/{@link ProviderModel}
 * types and their storage shapes alike. */
type ProviderLike = Pick<ProviderConnection, "id">
type ModelLike = Pick<ProviderModel, "modelId" | "piBinding">

/** pi provider key for a configured model: the bound pi provider id when the
 * model reuses a pi built-in, otherwise `aegisx-<providerId>` for a fully
 * custom provider. Mirrors the server's `resolvePiModelRef`/`piProviderKey*`
 * so refs formatted anywhere address the same model pi does. */
export function modelProviderKey(
  provider: ProviderLike,
  model: ModelLike
): string {
  return model.piBinding?.providerId ?? `aegisx-${provider.id}`
}

/** pi model id for a configured model: the bound pi model id when set,
 * otherwise the model's own `modelId`. */
export function piModelIdOf(model: ModelLike): string {
  return model.piBinding?.modelId ?? model.modelId
}

/** `"<providerKey>/<modelId>"` address (no effort suffix). */
export function modelAddress(provider: ProviderLike, model: ModelLike): string {
  return `${modelProviderKey(provider, model)}/${piModelIdOf(model)}`
}

/** Format a concrete model ref string from a provider/model pair + effort. */
export function formatModelRef(
  provider: ProviderLike,
  model: ModelLike,
  effort: ThinkingLevel
): ModelRef {
  return `${modelAddress(provider, model)}:${effort}`
}

export type ParsedModelRef =
  | { kind: "alias"; aliasId: string }
  | {
      kind: "model"
      providerKey: string
      modelId: string
      effort: ThinkingLevel
    }

/** Parse a model ref string. Returns null for a malformed/unrecognized string.
 * Alias refs are detected first (`alias:<id>`); otherwise the address is split
 * on the first `/` and the effort on the last `:` (only when the suffix is a
 * known thinking level — model ids never collide with the level names). */
export function parseModelRef(
  ref: string | null | undefined
): ParsedModelRef | null {
  if (!ref) return null
  // Capture the alias check as a plain boolean: isAliasRef is a `ref is string`
  // type guard, so using it directly in `if` would narrow an already-string
  // `ref` to `never` on the false branch below.
  const alias = isAliasRef(ref)
  if (alias) {
    const aliasId = refAliasId(ref)
    return aliasId ? { kind: "alias", aliasId } : null
  }
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
 * the currently-configured providers + aliases. Concrete refs match by pi
 * provider key + model id (so they survive label renames); alias refs resolve
 * to the first currently-available model in the alias and carry the alias's
 * reasoning level. Returns null when the ref is empty, malformed, or every
 * referenced model is unavailable.
 *
 * Pure (shared) — takes only the public provider/alias shapes, so both server
 * (run create / cold-restore / model-switch) and tests can use it. The caller
 * turns the resolved provider+model into an SDK model via its ModelRuntime.
 */
export function resolveModelRef<M extends ProviderModel>(
  ref: ModelRef | null | undefined,
  providers: ProviderConnection[],
  aliases: { id: string; modelIds: string[]; thinkingLevel: ThinkingLevel }[]
): ResolvedModelTarget<M> | null {
  const parsed = parseModelRef(ref)
  if (!parsed) return null

  const enabled = (provider: ProviderConnection) =>
    provider.enabled && !!provider.apiKey

  if (parsed.kind === "alias") {
    const alias = aliases.find((a) => a.id === parsed.aliasId)
    if (!alias) return null
    for (const modelId of alias.modelIds) {
      const found = findModelById(providers, modelId)
      if (found && enabled(found.provider) && found.model.enabled) {
        return {
          provider: found.provider,
          model: found.model as M,
          thinkingLevel: alias.thinkingLevel,
        }
      }
    }
    return null
  }

  for (const provider of providers) {
    if (!enabled(provider)) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      if (
        modelProviderKey(provider, model) === parsed.providerKey &&
        piModelIdOf(model) === parsed.modelId
      ) {
        return { provider, model: model as M, thinkingLevel: parsed.effort }
      }
    }
  }
  return null
}

/** Find a model by `ProviderModel.id` (UUID) across all providers (alias model
 * ids are UUIDs). Does not filter by enabled — alias resolution tolerates a
 * dangling/disabled model by falling through to the next id. */
function findModelById(
  providers: ProviderConnection[],
  modelId: string
): { provider: ProviderConnection; model: ProviderModel } | null {
  for (const provider of providers) {
    const model = provider.models.find((m) => m.id === modelId)
    if (model) return { provider, model }
  }
  return null
}

/** Human-readable summary of a ref for display where a full resolve isn't
 * available (logs, fallbacks). Returns the input verbatim for concretes and
 * `alias:<id>` for aliases. */
export function describeModelRef(ref: ModelRef | null | undefined): string {
  return ref ?? ""
}
