import type { ProviderConnection, ProviderModel } from "./domain"
import { isThinkingLevel, type ThinkingLevel } from "./live-event"

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

/**
 * Model aliases — named shortcuts that resolve to an ordered list of provider
 * models plus a reasoning level. Stored in config.json alongside
 * providers/settings (no DB table).
 *
 * A persisted model reference (e.g. `agent.defaultModelId`,
 * `scheduler_config.modelId`) may be either a raw `ProviderModel.id` (UUID) or
 * an alias reference of the form `alias:<id>`. The server resolves alias refs
 * to the first *currently-available* model in the alias's ordered list at the
 * moment of use, so re-pointing an alias (model or thinking) is a global, live
 * change for any default slot that references it. Per-agent snapshots (run
 * rows, switch-model) capture a concrete model + thinking and do not follow
 * later alias edits.
 */
export type ModelAlias = {
  id: string
  label: string
  /** Ordered list of `ProviderModel.id` values; the first currently-available
   * one wins. The data model supports a fallback chain; the v1 UI exposes a
   * single model per alias. */
  modelIds: string[]
  /** Reasoning level applied when this alias is selected (as a preset) or
   * resolved as a default. */
  thinkingLevel: ThinkingLevel
}

/** Prefix marking a stored model ref as an alias reference. */
export const ALIAS_REF_PREFIX = "alias:"

export function aliasRef(id: string): string {
  return `${ALIAS_REF_PREFIX}${id}`
}

/** Type-test whether a value is an `alias:<id>` ref string. The predicate is a
 * template-literal type so callers branching on an already-`string` value keep
 * the non-alias branch as `string` (not `never`). */
export function isAliasRef(
  ref: string | null | undefined
): ref is `alias:${string}` {
  return typeof ref === "string" && ref.startsWith(ALIAS_REF_PREFIX)
}

/** Extract the alias id from an alias ref, or null for a raw model id. */
export function refAliasId(ref: string): string | null {
  return isAliasRef(ref) ? ref.slice(ALIAS_REF_PREFIX.length) : null
}

/** Coerce one raw alias entry into a {@link ModelAlias}, or drop it. */
export function normalizeAlias(raw: unknown): ModelAlias | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== "string" || !entry.id) return undefined
  const label = typeof entry.label === "string" ? entry.label : ""
  const modelIds = Array.isArray(entry.modelIds)
    ? entry.modelIds.filter(
        (m): m is string => typeof m === "string" && m.length > 0
      )
    : []
  const thinkingLevel = isThinkingLevel(entry.thinkingLevel)
    ? entry.thinkingLevel
    : "off"
  return { id: entry.id, label, modelIds, thinkingLevel }
}

/** Coerce a raw array into a clean {@link ModelAlias} list. */
export function parseAliases(raw: unknown): ModelAlias[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(normalizeAlias)
    .filter((alias): alias is ModelAlias => alias !== undefined)
}

/** Resolve one alias to the first available model via the caller-supplied
 * lookup (model id → model). Returns null when the alias is empty or every
 * referenced model is dangling/unavailable. */
export function resolveAliasToModel<M>(
  alias: ModelAlias,
  lookup: (modelId: string) => M | undefined
): M | null {
  for (const id of alias.modelIds) {
    const found = lookup(id)
    if (found) return found
  }
  return null
}

/** Resolve a stored model ref (`alias:<id>` or a raw model id) to a concrete
 * model via the caller-supplied lookup. The `aliases` list supplies alias
 * definitions; passing an empty list makes alias refs unresolvable. */
export function resolveModelTarget<M>(
  ref: string | null | undefined,
  lookup: (modelId: string) => M | undefined,
  aliases: ModelAlias[]
): M | null {
  if (!ref) return null
  if (isAliasRef(ref)) {
    const alias = aliases.find((a) => a.id === refAliasId(ref))
    return alias ? resolveAliasToModel(alias, lookup) : null
  }
  return lookup(ref) ?? null
}

/** Resolve one alias to its model + reasoning level, or null when the alias is
 * empty or every referenced model is dangling/unavailable. */
export function resolveAliasToTarget<M>(
  alias: ModelAlias,
  lookup: (modelId: string) => M | undefined
): { model: M; thinkingLevel: ThinkingLevel } | null {
  for (const id of alias.modelIds) {
    const found = lookup(id)
    if (found) return { model: found, thinkingLevel: alias.thinkingLevel }
  }
  return null
}

/** Resolve a stored model ref to a concrete model plus, for alias refs, the
 * alias's reasoning level. `thinkingLevel` is null for raw model ids (no
 * override; the caller falls back to its own default). Returns null when the
 * ref is empty or resolves to nothing. */
export function resolveRefTarget<M>(
  ref: string | null | undefined,
  lookup: (modelId: string) => M | undefined,
  aliases: ModelAlias[]
): { model: M; thinkingLevel: ThinkingLevel | null } | null {
  if (!ref) return null
  if (isAliasRef(ref)) {
    const alias = aliases.find((a) => a.id === refAliasId(ref))
    if (!alias) return null
    const target = resolveAliasToTarget(alias, lookup)
    return target ?? null
  }
  const model = lookup(ref)
  return model ? { model, thinkingLevel: null } : null
}

/**
 * Body for a runtime model switch (run entry agent + per-agent + event
 * orchestrator). `model` is a canonical model ref string
 * (`<providerKey>/<modelId>:<effort>` or `alias:<id>`) — the resolved provider
 * + model + effort are snapshotted onto the agent row, and the SDK model is
 * swapped on the live session. Both are persisted by the SDK as
 * `model_change` / `thinking_level_change` session entries, so the switch is
 * visible in the timeline.
 */
export type SwitchModelInput = {
  model: ModelRef
}
