import {
  aliasRef,
  isAliasRef,
  parseModelRef,
  resolveAliasToModel,
  type ModelAlias,
  type ModelRef,
} from "@aegisx/shared"
import type { ProviderConnection } from "@aegisx/shared/provider"
import type { ThinkingLevel } from "@aegisx/shared/thinking"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"

import { aliasesApi, keys, providersApi } from "@/api"
import { Badge } from "@/components/ui/badge"
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

export const THINKING_LEVELS = Object.keys(
  thinkingLevelLabels
) as ThinkingLevel[]

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
export function useModelAliases(): ModelAlias[] {
  const aliases = useQuery({
    queryKey: keys.aliases.all,
    queryFn: () => aliasesApi.listAliases(),
  })
  return aliases.data?.items ?? []
}

/** Aliases that currently resolve to an enabled available model, paired with
 * their resolved model. Aliases resolving to nothing are hidden. */
export function useResolvedAliases(models: AvailableModel[]) {
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
export function useAvailableModels() {
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
export function groupByProvider(models: AvailableModel[]) {
  const map = new Map<string, AvailableModel[]>()
  for (const m of models) {
    const bucket = map.get(m.providerLabel) ?? []
    bucket.push(m)
    map.set(m.providerLabel, bucket)
  }
  return [...map.entries()]
}

/**
 * Compact model + reasoning selectors for the conversation composer footer.
 * Drives a live session switch via `onSwitch` (caller POSTs .../switch-model).
 *
 * The current model is resolved from the providers list by `findCurrentModelId`
 * because the run row stores the underlying modelId string while the
 * orchestrator row already stores the UUID — the parent supplies the matcher.
 *
 * `onSwitch` receives a canonical model ref string
 * (`<providerKey>/<modelId>:<effort>` or `alias:<id>`); the caller forwards it
 * verbatim to the model-switch API. Switching takes effect on the next turn
 * (the in-flight turn, if any, finishes on the old model).
 */
export function ModelThinkingSwitcher({
  findCurrentModelId,
  thinkingLevel,
  disabled,
  onSwitch,
  className,
}: {
  findCurrentModelId: (models: AvailableModel[]) => string | null | undefined
  thinkingLevel: ThinkingLevel
  disabled?: boolean
  onSwitch: (ref: ModelRef) => void
  className?: string
}) {
  const models = useAvailableModels()
  const resolvedAliases = useResolvedAliases(models)

  const currentId = findCurrentModelId(models) ?? null
  const [selectedId, setSelectedId] = useState<string | null>(currentId)
  useEffect(() => {
    setSelectedId(currentId)
  }, [currentId])

  const selected = useMemo(() => {
    if (isAliasRef(selectedId)) {
      return (
        resolvedAliases.find((r) => aliasRef(r.alias.id) === selectedId)
          ?.target ?? null
      )
    }
    return models.find((m) => m.id === selectedId) ?? null
  }, [selectedId, models, resolvedAliases])
  const supportedThinking = selected?.thinkingLevels ?? ["off"]
  const [thinking, setThinking] = useState<ThinkingLevel>(thinkingLevel)
  useEffect(() => {
    setThinking(thinkingLevel)
  }, [thinkingLevel])

  // Clamp the reasoning level to whatever the selected model supports.
  useEffect(() => {
    if (!supportedThinking.includes(thinking)) {
      setThinking(supportedThinking[0] ?? "off")
    }
  }, [supportedThinking, thinking])

  const grouped = useMemo(() => groupByProvider(models), [models])

  const emit = (modelId: string | null, level: ThinkingLevel) => {
    if (!modelId) return
    if (isAliasRef(modelId)) {
      onSwitch(modelId)
      return
    }
    const m = models.find((x) => x.id === modelId)
    if (m) onSwitch(`${m.address}:${level}`)
  }

  const handleModel = (id: string | null) => {
    if (!id) return
    setSelectedId(id)
    const entry = isAliasRef(id)
      ? resolvedAliases.find((r) => aliasRef(r.alias.id) === id)
      : null
    const m = entry?.target ?? models.find((x) => x.id === id)
    const levels = m?.thinkingLevels ?? ["off"]
    // An alias carries its own reasoning level (clamped to the resolved
    // model's supported levels); a raw model id keeps the current thinking.
    const aliasThinking = entry?.alias.thinkingLevel
    const next =
      aliasThinking && levels.includes(aliasThinking)
        ? aliasThinking
        : levels.includes(thinking)
          ? thinking
          : (levels[0] ?? "off")
    setThinking(next)
    emit(id, next)
  }
  const handleThinking = (level: ThinkingLevel) => {
    setThinking(level)
    if (selectedId) emit(selectedId, level)
  }

  if (models.length === 0) return null

  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <Select
        items={Object.fromEntries([
          ...resolvedAliases.map((r) => [aliasRef(r.alias.id), r.alias.label]),
          ...models.map((m) => [m.id, m.label]),
        ])}
        onValueChange={handleModel}
        value={selectedId ?? undefined}
      >
        <SelectTrigger
          className="h-7 max-w-[16rem] min-w-[7rem] px-2 font-mono text-xs"
          disabled={disabled}
          size="sm"
        >
          <SelectValue placeholder="模型" />
        </SelectTrigger>
        <SelectPopup>
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
                    {alias.thinkingLevel !== "off" && (
                      <Badge size="sm" variant="secondary">
                        {thinkingLevelLabels[alias.thinkingLevel]}
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {grouped.map(([providerLabel, list]) => (
            <SelectGroup key={providerLabel}>
              <SelectGroupLabel>{providerLabel}</SelectGroupLabel>
              {list.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectPopup>
      </Select>
      <Select
        items={Object.fromEntries(
          supportedThinking.map((level) => [level, thinkingLevelLabels[level]])
        )}
        onValueChange={(value) => {
          if (value) handleThinking(value as ThinkingLevel)
        }}
        value={thinking}
      >
        <SelectTrigger
          className="h-7 min-w-[4.5rem] px-2 font-mono text-xs"
          disabled={disabled || supportedThinking.length <= 1}
          size="sm"
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
    </span>
  )
}

/**
 * Config-time model ref picker (orchestration settings): selects a concrete
 * `<address>:<effort>` ref or an alias ref, with a leading "默认" entry that
 * clears the slot (null → global default). Uncontrolled-ish: derives the
 * select values from `value` and calls `onChange` with the resulting ref.
 *
 * Unlike {@link ModelThinkingSwitcher} this is not bound to a live session, so
 * it shows the alias/concrete split purely from the parsed ref.
 */
export function ModelRefPicker({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: ModelRef | null
  onChange: (ref: ModelRef | null) => void
  disabled?: boolean
  /** Tighter trigger sizing for inline table rows. */
  compact?: boolean
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
    if (selectedAliasId) return // alias effort is fixed
    if (selectedAddress) onChange(`${selectedAddress}:${level}`)
  }

  const triggerClass = compact
    ? "h-8 min-w-[12rem] text-xs"
    : "h-9 min-w-[14rem]"

  return (
    <span className="flex items-center gap-1.5">
      <Select
        disabled={disabled}
        items={Object.fromEntries([
          ["", "默认（全局默认模型）"],
          ...resolvedAliases.map((r) => [aliasRef(r.alias.id), r.alias.label]),
          ...models.map((m) => [m.address, m.label]),
        ])}
        onValueChange={applyModel}
        value={modelValue}
      >
        <SelectTrigger
          className={triggerClass}
          size={compact ? "sm" : "default"}
        >
          <SelectValue placeholder="默认" />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="">默认（全局默认模型）</SelectItem>
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
      {!selectedAliasId && (
        <Select
          disabled={disabled || supportedThinking.length <= 1}
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
            className={cn(
              compact ? "h-8 w-[7.5rem]" : "h-9 w-[8.5rem]",
              "text-xs"
            )}
            size={compact ? "sm" : "default"}
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
