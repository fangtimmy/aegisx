import {
  aliasRef,
  isAliasRef,
  resolveAliasToModel,
  type ModelAlias,
} from "@aegisx/shared"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"

import { aliasesApi, keys, providersApi, type ThinkingLevel } from "@/api"
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

type AvailableModel = {
  /** ProviderModel.id (UUID) — what the switch-model API takes. */
  id: string
  /** Underlying model id string (matches RunPublic.modelId). */
  modelId: string
  label: string
  providerLabel: string
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

/** Enabled provider models flattened to {@link AvailableModel}, grouped-ready.
 * Shared by the composer model switcher and the scheduler config editor. */
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
          thinkingLevels: model.thinkingLevels,
        })
      }
    }
    return out
  }, [providers.data])
}

/**
 * Compact model + reasoning selectors for the conversation composer footer.
 * Drives a live session switch via `onSwitch` (caller POSTs .../switch-model).
 *
 * The current model is resolved from the providers list by `findCurrentModelId`
 * because the run row stores the underlying modelId string while the
 * orchestrator row already stores the UUID — the parent supplies the matcher.
 *
 * Switching takes effect on the next turn (the in-flight turn, if any, finishes
 * on the old model).
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
  onSwitch: (input: { modelId: string; thinkingLevel: ThinkingLevel }) => void
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

  const grouped = useMemo(() => {
    const map = new Map<string, AvailableModel[]>()
    for (const m of models) {
      const bucket = map.get(m.providerLabel) ?? []
      bucket.push(m)
      map.set(m.providerLabel, bucket)
    }
    return [...map.entries()]
  }, [models])

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
    onSwitch({ modelId: id, thinkingLevel: next })
  }
  const handleThinking = (level: ThinkingLevel) => {
    setThinking(level)
    if (selected) onSwitch({ modelId: selected.id, thinkingLevel: level })
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
