import type { ThinkingLevel } from "./thinking"
import { isThinkingLevel } from "./thinking"

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
