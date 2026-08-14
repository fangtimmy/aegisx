import {
  aliasRef,
  isAliasRef,
  parseModelRef,
  resolveAliasToModel,
  type ModelAlias,
  type ModelRef,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/domain"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { aliasesApi, keys, providersApi } from "@/api"
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
}

const THINKING_LEVELS = Object.keys(thinkingLevelLabels) as ThinkingLevel[]

type AvailableModel = {
  /** ProviderModel.id (UUID) — alias model ids reference this. */
  id: string
  /** Underlying pi model id (matches the ref's modelId segment). */
  modelId: string
  label: string
  providerLabel: string
  /** Canonical pi address (`<providerKey>/<modelId>`) — the ref's model segment. */
  address: string
  thinkingLevels: ThinkingLevel[]
}

export type { AvailableModel }

/** Configured model aliases (GET /api/model-aliases). Shared by every model
 * selector that surfaces an "别名" group. */
function useModelAliases(): ModelAlias[] {
  const aliases = useQuery({
    queryKey: keys.aliases.all,
    queryFn: () => aliasesApi.listAliases(),
  })
  return aliases.data?.items ?? []
}

/** Aliases that currently resolve to an enabled available model, paired with
 * their resolved model. Aliases resolving to nothing are hidden. */
function useResolvedAliases(models: AvailableModel[]) {
  const aliases = useModelAliases()
  return useMemo(() => {
    const byId = new Map(models.map((m) => [m.id, m]))
    return aliases
      .map((alias) => {
        const target = resolveAliasToModel(alias, (id) => byId.get(id))
        return target ? { alias, target } : null
      })
      .filter(
        (entry): entry is { alias: ModelAlias; target: AvailableModel } =>
          entry !== null
      )
  }, [aliases, models])
}

/** Enabled provider models flattened to {@link AvailableModel} (with the pi
 * address needed to build canonical refs), grouped-ready. Shared by every
 * model ref selector. */
function useAvailableModels() {
  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })
  return useMemo<AvailableModel[]>(() => {
    const items = providers.data?.items ?? []
    const out: AvailableModel[] = []
    for (const provider of items) {
      if (!provider.enabled || !provider.apiKey) continue
      for (const model of provider.models) {
        if (!model.enabled) continue
        out.push({
          id: model.id,
          modelId: model.modelId,
          label: model.label,
          providerLabel: provider.label,
          address: modelAddress(provider, model),
          thinkingLevels: model.thinkingLevels,
        })
      }
    }
    return out
  }, [providers.data])
}

/** `providerKey/modelId` for a configured provider+model (mirrors the shared
 * modelAddress helper without importing the generic form). */
function modelAddress(
  provider: ProviderConnection,
  model: {
    modelId: string
    piBinding: { providerId: string; modelId: string } | null
  }
): string {
  const providerKey = model.piBinding?.providerId ?? `aegisx-${provider.id}`
  const piModelId = model.piBinding?.modelId ?? model.modelId
  return `${providerKey}/${piModelId}`
}

/** Models grouped by provider label (for grouped selects). */
function groupByProvider(models: AvailableModel[]) {
  const map = new Map<string, AvailableModel[]>()
  for (const m of models) {
    const bucket = map.get(m.providerLabel) ?? []
    bucket.push(m)
    map.set(m.providerLabel, bucket)
  }
  return [...map.entries()]
}

/**
 * The one model selector for every "pick a model + reasoning effort" surface.
 * Consumes and produces the canonical ref string
 * (`<providerKey>/<modelId>:<effort>` or `alias:<id>`).
 *
 * Prefers a single model-list dropdown (aliases + providers, grouped). The
 * effort dropdown only appears when the selection is a concrete model that
 * supports more than one thinking level — a single-level model carries its
 * only level implicitly, and an alias carries its own. When `allowEmpty` the
 * leading option clears the ref (null → fall back to the global default in
 * slot config / no default in the settings page); runtime switching (live
 * agent) passes `allowEmpty={false}`.
 *
 * Controlled: derives its values from `value`, reports via `onChange`.
 */
export function ModelRefPicker({
  value,
  onChange,
  disabled,
  allowEmpty,
  size = "default",
  className,
  emptyLabel = "默认",
}: {
  value: ModelRef | null
  onChange: (ref: ModelRef | null) => void
  disabled?: boolean
  /** Show the empty (null) option. Config scenarios (default model, slot,
   * scheduler) pass true; live runtime switching passes false. */
  allowEmpty?: boolean
  /** Tighter trigger sizing for inline rows / composer footers. */
  size?: "sm" | "default"
  className?: string
  /** Label for the empty (null) option (only rendered when allowEmpty). */
  emptyLabel?: string
}) {
  const models = useAvailableModels()
  const resolvedAliases = useResolvedAliases(models)
  const grouped = useMemo(() => groupByProvider(models), [models])

  // Parse the current ref into a select value (alias ref, concrete address, or
  // empty = default) + an effort level.
  const parsed = useMemo(() => parseModelRef(value), [value])
  const selectedAddress =
    parsed?.kind === "model" ? `${parsed.providerKey}/${parsed.modelId}` : null
  const selectedAliasId = parsed?.kind === "alias" ? parsed.aliasId : null
  const effort =
    parsed?.kind === "model"
      ? parsed.effort
      : parsed?.kind === "alias"
        ? (resolvedAliases.find((r) => r.alias.id === parsed.aliasId)?.alias
            .thinkingLevel ?? "off")
        : "off"

  // The model select's value: an alias ref, a concrete address, or "" (default).
  const modelValue = selectedAliasId
    ? aliasRef(selectedAliasId)
    : (selectedAddress ?? "")

  // The selected concrete model (for its supported thinking levels). Aliases
  // resolve to their first available model; the effort comes from the alias.
  const selectedModel = useMemo(() => {
    if (selectedAliasId) {
      return (
        resolvedAliases.find((r) => r.alias.id === selectedAliasId)?.target ??
        null
      )
    }
    return models.find((m) => m.address === selectedAddress) ?? null
  }, [selectedAliasId, selectedAddress, models, resolvedAliases])
  const supportedThinking = selectedModel?.thinkingLevels ?? THINKING_LEVELS

  // The effort dropdown only shows when the selection is a concrete model with
  // more than one thinking level to choose from.
  const showEffort =
    !selectedAliasId && !!selectedAddress && supportedThinking.length > 1

  const applyModel = (key: string | null) => {
    if (!key) {
      onChange(null)
      return
    }
    if (isAliasRef(key)) {
      onChange(key)
      return
    }
    // key is a concrete address → keep the current effort if supported.
    const m = models.find((x) => x.address === key)
    const levels = m?.thinkingLevels ?? ["off"]
    const next = levels.includes(effort) ? effort : (levels[0] ?? "off")
    onChange(`${key}:${next}`)
  }
  const applyEffort = (level: ThinkingLevel) => {
    if (selectedAddress) onChange(`${selectedAddress}:${level}`)
  }

  const sm = size === "sm"
  const triggerClass = sm ? "h-8 min-w-[12rem] text-xs" : "h-9 min-w-[14rem]"

  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <Select
        disabled={disabled}
        items={Object.fromEntries([
          ...(allowEmpty ? [["", emptyLabel]] : []),
          ...resolvedAliases.map((r) => [aliasRef(r.alias.id), r.alias.label]),
          ...models.map((m) => [m.address, m.label]),
        ])}
        onValueChange={applyModel}
        value={modelValue}
      >
        <SelectTrigger className={triggerClass} size={sm ? "sm" : "default"}>
          <SelectValue placeholder={allowEmpty ? emptyLabel : "选择模型"} />
        </SelectTrigger>
        <SelectPopup>
          {allowEmpty && <SelectItem value="">{emptyLabel}</SelectItem>}
          {resolvedAliases.length > 0 && (
            <SelectGroup key="aliases">
              <SelectGroupLabel>别名</SelectGroupLabel>
              {resolvedAliases.map(({ alias, target }) => (
                <SelectItem key={aliasRef(alias.id)} value={aliasRef(alias.id)}>
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">{alias.label}</span>
                    <span className="text-muted-foreground">
                      → {target.label}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {grouped.map(([providerLabel, list]) => (
            <SelectGroup key={providerLabel}>
              <SelectGroupLabel>{providerLabel}</SelectGroupLabel>
              {list.map((m) => (
                <SelectItem key={m.address} value={m.address}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectPopup>
      </Select>
      {showEffort && (
        <Select
          disabled={disabled}
          items={Object.fromEntries(
            supportedThinking.map((level) => [
              level,
              thinkingLevelLabels[level],
            ])
          )}
          onValueChange={(v) => v && applyEffort(v as ThinkingLevel)}
          value={effort}
        >
          <SelectTrigger
            className={cn(sm ? "h-8 w-[7.5rem]" : "h-9 w-[8.5rem]", "text-xs")}
            size={sm ? "sm" : "default"}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {supportedThinking.map((level) => (
              <SelectItem key={level} value={level}>
                {thinkingLevelLabels[level]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </span>
  )
}
