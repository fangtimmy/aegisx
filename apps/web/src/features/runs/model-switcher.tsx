import { parseModelRef, type ModelRef } from "@aegisx/shared"
import type { ThinkingLevel } from "@aegisx/shared/live-event"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { keys, providersApi } from "@/api"
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

/** Models grouped by provider label (for grouped selects). */
function groupByProvider(
  models: Awaited<ReturnType<typeof providersApi.listModels>>["items"]
) {
  const map = new Map<string, typeof models>()
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
 * (`<providerKey>/<modelId>:<effort>`).
 *
 * Lazy semantics: an agent keeps its model snapshot until explicitly switched.
 * When the current ref points at a provider/model that was since disabled or
 * deleted (so it is missing from the available list), the picker still shows it
 * as a "当前使用" entry — the list is the current model + the up-to-date
 * available models. The effort dropdown only appears when the selection is a
 * concrete model that supports more than one thinking level — a single-level
 * model carries its only level implicitly. When `allowEmpty` the leading option
 * clears the ref (null → fall back to the global default in slot config / no
 * default in the settings page); runtime switching (live agent) passes
 * `allowEmpty={false}`.
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
  const models = useQuery({
    queryKey: keys.models.all,
    queryFn: () => providersApi.listModels(),
  })
  const items = useMemo(() => models.data?.items ?? [], [models.data])
  const grouped = useMemo(() => groupByProvider(items), [items])

  // Parse the current ref into a select value (concrete address, or "" =
  // default) + an effort level.
  const parsed = useMemo(() => parseModelRef(value), [value])
  const selectedAddress =
    parsed?.kind === "model" ? `${parsed.providerKey}/${parsed.modelId}` : null
  const effort = parsed?.kind === "model" ? parsed.effort : "off"
  const modelValue = selectedAddress ?? ""

  // The currently-selected model may be absent from the available list (its
  // provider/model was disabled or deleted while the agent kept its snapshot).
  // Keep it visible so the picker reflects what the agent actually runs.
  const dangling =
    !!selectedAddress && !items.some((m) => m.address === selectedAddress)
  const selectedModel = useMemo(
    () => items.find((m) => m.address === selectedAddress) ?? null,
    [selectedAddress, items]
  )
  const supportedThinking = selectedModel?.thinkingLevels ?? THINKING_LEVELS

  // The effort dropdown only shows when the selection is a concrete model with
  // more than one thinking level to choose from.
  const showEffort = !!selectedAddress && supportedThinking.length > 1

  const applyModel = (key: string | null) => {
    if (!key) {
      onChange(null)
      return
    }
    // key is a concrete address → keep the current effort if supported.
    const m = items.find((x) => x.address === key)
    const levels = m?.thinkingLevels ?? ["off"]
    const next = levels.includes(effort) ? effort : (levels[0] ?? "off")
    onChange(`${key}:${next}`)
  }
  const applyEffort = (level: ThinkingLevel) => {
    if (selectedAddress) onChange(`${selectedAddress}:${level}`)
  }

  const sm = size === "sm"
  const triggerClass = sm ? "h-8 min-w-[12rem] text-xs" : "h-9 min-w-[14rem]"

  const optionItems: Record<string, string> = {}
  if (allowEmpty) optionItems[""] = emptyLabel
  if (dangling && selectedAddress) {
    optionItems[selectedAddress] =
      parsed?.kind === "model" ? parsed.modelId : selectedAddress
  }
  for (const m of items) optionItems[m.address] = m.label

  // Live-switch context (!allowEmpty): the currently-running model is a
  // snapshot — show it as a DISABLED "当前使用" entry so the user can switch
  // OUT to a fresh model but never no-op back to the same address (which
  // would skip setModel and fail to pick up provider/apiKey edits). The
  // available list excludes the current address so any selected switch is a
  // real change. Config scenarios (allowEmpty) keep the old dangling-only
  // behavior.
  const live = !allowEmpty
  const currentLabel = selectedModel
    ? selectedModel.label
    : parsed?.kind === "model"
      ? parsed.modelId
      : selectedAddress

  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <Select
        disabled={disabled}
        items={optionItems}
        onValueChange={applyModel}
        value={modelValue}
      >
        <SelectTrigger className={triggerClass} size={sm ? "sm" : "default"}>
          <SelectValue placeholder={allowEmpty ? emptyLabel : "选择模型"} />
        </SelectTrigger>
        <SelectPopup>
          {allowEmpty && <SelectItem value="">{emptyLabel}</SelectItem>}
          {live && selectedAddress && (
            <SelectGroup key="current">
              <SelectGroupLabel>当前使用</SelectGroupLabel>
              <SelectItem disabled value={selectedAddress}>
                {currentLabel}
                {!selectedModel && "（不可用）"}
              </SelectItem>
            </SelectGroup>
          )}
          {!live && dangling && selectedAddress && (
            <SelectGroup key="current">
              <SelectGroupLabel>当前使用</SelectGroupLabel>
              <SelectItem value={selectedAddress}>
                {parsed?.kind === "model" ? parsed.modelId : selectedAddress}
                （不可用）
              </SelectItem>
            </SelectGroup>
          )}
          {grouped.map(([providerLabel, list]) => {
            const visible = live
              ? list.filter((m) => m.address !== selectedAddress)
              : list
            return (
              <SelectGroup key={providerLabel}>
                <SelectGroupLabel>{providerLabel}</SelectGroupLabel>
                {visible.map((m) => (
                  <SelectItem key={m.address} value={m.address}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )
          })}
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
