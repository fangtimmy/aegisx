import { aliasRef, resolveAliasToModel } from "@aegisx/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RotateCcw, Search } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import {
  aliasesApi,
  type FlatSettings,
  isSettingModified,
  keys,
  type ModelAlias,
  type ProviderConnection,
  SETTINGS_DEFS,
  type SettingDef,
  type SettingKey,
  type SettingsResponse,
  settingsApi,
  type ThinkingLevel,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/lib/toast"
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

function matchesQuery(def: SettingDef, query: string) {
  if (!query) return true
  const hay =
    `${def.key} ${def.title} ${def.description ?? ""} ${def.group}`.toLowerCase()
  return hay.includes(query.toLowerCase())
}

function ResetSlot({
  modified,
  disabled,
  onReset,
}: {
  modified: boolean
  disabled?: boolean
  onReset: () => void
}) {
  return (
    <div className="flex size-7 shrink-0 items-center justify-center">
      {modified ? (
        <Button
          aria-label="重置为默认"
          className="size-7"
          disabled={disabled}
          onClick={onReset}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RotateCcw className="size-3.5" />
        </Button>
      ) : (
        <span aria-hidden className="size-7" />
      )}
    </div>
  )
}

function SettingMeta({ def }: { def: SettingDef }) {
  return (
    <div className="min-w-0">
      <div className="text-sm leading-7 font-medium">{def.title}</div>
      {def.description && (
        <p className="text-xs leading-snug text-muted-foreground">
          {def.description}
        </p>
      )}
      <code className="block text-[11px] leading-snug text-muted-foreground">
        {def.key}
      </code>
    </div>
  )
}

function SettingRow({
  def,
  modified,
  disabled,
  onReset,
  children,
}: {
  def: SettingDef
  modified: boolean
  disabled?: boolean
  onReset: () => void
  children: ReactNode
}) {
  const gutter = (
    <div
      aria-hidden
      className={cn(
        "min-h-7 self-stretch rounded-e-sm",
        modified ? "bg-primary" : "bg-transparent"
      )}
    />
  )

  return (
    <div className="grid grid-cols-[2px_minmax(0,1fr)_minmax(12rem,18rem)_1.75rem] items-center gap-x-3 py-2 pr-2">
      {gutter}
      <div className="min-w-0">
        <SettingMeta def={def} />
      </div>
      <div
        className={cn(
          "min-w-0",
          def.widget === "boolean" && "flex justify-end"
        )}
      >
        {children}
      </div>
      <ResetSlot disabled={disabled} modified={modified} onReset={onReset} />
    </div>
  )
}

function ModelSettingControl({
  value,
  disabled,
  onChange,
  providers,
}: {
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
  providers?: ProviderConnection[]
}) {
  const aliasesQuery = useQuery({
    queryKey: keys.aliases.all,
    queryFn: () => aliasesApi.listAliases(),
  })
  const models = useMemo(
    () =>
      (providers ?? []).flatMap((provider) =>
        provider.enabled && provider.apiKey
          ? provider.models
              .filter((model) => model.enabled)
              .map((model) => ({ ...model, provider }))
          : []
      ),
    [providers]
  )
  const aliases = aliasesQuery.data?.items ?? []
  // Aliases that resolve to an available model (the live default follows an
  // alias, so only show ones that currently resolve).
  const resolvedAliases = useMemo(() => {
    const byId = new Map(models.map((m) => [m.id, m]))
    return aliases
      .map((alias) => {
        const target = resolveAliasToModel(alias, (id) => byId.get(id))
        return target ? { alias, target } : null
      })
      .filter(
        (
          entry
        ): entry is { alias: ModelAlias; target: (typeof models)[number] } =>
          entry !== null
      )
  }, [aliases, models])

  const current = typeof value === "string" ? value : ""
  return (
    <Select
      disabled={disabled}
      items={Object.fromEntries([
        ["", "无默认模型"],
        ...resolvedAliases.map(({ alias, target }) => [
          aliasRef(alias.id),
          `${alias.label} (→ ${target.provider.label} / ${target.label})`,
        ]),
        ...models.map((model) => [
          model.id,
          `${model.provider.label} / ${model.label}`,
        ]),
      ])}
      onValueChange={(next) => onChange(next || null)}
      value={current}
    >
      <SelectTrigger>
        <SelectValue placeholder="无默认模型" />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="">无默认模型</SelectItem>
        {resolvedAliases.length > 0 && (
          <SelectGroup key="aliases">
            <SelectGroupLabel>别名</SelectGroupLabel>
            {resolvedAliases.map(({ alias, target }) => (
              <SelectItem key={aliasRef(alias.id)} value={aliasRef(alias.id)}>
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{alias.label}</span>
                  <span className="text-muted-foreground">
                    → {target.provider.label} / {target.label}
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
        {(providers ?? []).map((provider) => {
          const providerModels = models.filter(
            (model) => model.provider.id === provider.id
          )
          if (providerModels.length === 0) return null
          return (
            <SelectGroup key={provider.id}>
              <SelectGroupLabel>{provider.label}</SelectGroupLabel>
              {providerModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
      </SelectPopup>
    </Select>
  )
}

function SettingControl({
  def,
  value,
  disabled,
  onChange,
  providers,
}: {
  def: SettingDef
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
  providers?: ProviderConnection[]
}) {
  if (def.widget === "boolean") {
    return (
      <Switch
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
    )
  }
  if (
    def.widget === "number" &&
    (def.type === "integer" || def.type === "number")
  ) {
    return (
      <NumberField
        disabled={disabled}
        max={def.maximum}
        min={def.minimum}
        onValueChange={(next) => {
          if (typeof next === "number") onChange(next)
        }}
        step={def.step ?? (def.type === "integer" ? 1 : 0.1)}
        value={typeof value === "number" ? value : def.default}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
    )
  }
  if (def.widget === "select" && def.type === "enum") {
    const items = Object.fromEntries(
      def.enum.map((item) => [item.value, item.label])
    )
    return (
      <Select
        disabled={disabled}
        items={items}
        onValueChange={(next) => onChange(next)}
        value={typeof value === "string" ? value : String(def.default)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {def.enum.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    )
  }
  if (def.widget === "model") {
    return (
      <ModelSettingControl
        disabled={disabled}
        onChange={onChange}
        providers={providers}
        value={value}
      />
    )
  }
  if (def.widget === "text") {
    return (
      <Input
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={typeof value === "string" ? value : ""}
      />
    )
  }
  return null
}

export function SchemaSettingsForm({
  data,
  providers,
}: {
  data: SettingsResponse
  providers: ProviderConnection[]
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [modifiedOnly, setModifiedOnly] = useState(false)
  const [local, setLocal] = useState(data.settings)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    return () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
    }
  }, [])

  const save = useMutation({
    mutationFn: (patch: Partial<Record<SettingKey, unknown>>) =>
      settingsApi.updateSettings(patch as Partial<FlatSettings>),
    onSuccess: (response) => {
      queryClient.setQueryData(keys.settings.all, response)
      if (timers.current.size === 0) {
        setLocal(response.settings)
      }
    },
    onError: (error) => toast.error("保存设置失败", error.message),
  })

  function scheduleSave(key: SettingKey, value: unknown) {
    setLocal((current) => ({ ...current, [key]: value }) as typeof local)
    const existing = timers.current.get(key)
    if (existing) clearTimeout(existing)
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key)
        save.mutate({ [key]: value })
      }, 400)
    )
  }

  function resetKey(def: SettingDef) {
    scheduleSave(def.key, def.default)
  }

  const modifiedCount = useMemo(
    () =>
      SETTINGS_DEFS.filter((def) => isSettingModified(local, def.key)).length,
    [local]
  )

  const groups = useMemo(() => {
    const filtered = SETTINGS_DEFS.filter((def) => {
      if (!matchesQuery(def, query)) return false
      if (modifiedOnly && !isSettingModified(local, def.key)) return false
      return true
    }).sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order)
    const map = new Map<string, SettingDef[]>()
    for (const def of filtered) {
      const list = map.get(def.group) ?? []
      list.push(def)
      map.set(def.group, list)
    }
    return [...map.entries()]
  }, [query, modifiedOnly, local])

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex items-center gap-3">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupInput
            aria-label="搜索设置"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设置"
            type="search"
            value={query}
          />
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
        </InputGroup>
        <div className="flex items-center gap-2 text-sm whitespace-nowrap">
          <Switch
            checked={modifiedOnly}
            id="settings-modified-only"
            onCheckedChange={(checked) => setModifiedOnly(checked === true)}
          />
          <label htmlFor="settings-modified-only">
            仅显示已修改
            {modifiedCount > 0 && (
              <span className="text-muted-foreground"> ({modifiedCount})</span>
            )}
          </label>
        </div>
      </div>
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">没有匹配的设置项。</p>
      )}
      {groups.map(([group, defs]) => (
        <section key={group}>
          <h2 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group}
          </h2>
          <div className="divide-y overflow-hidden rounded-lg border">
            {defs.map((def) => {
              const value = local[def.key]
              const modified = isSettingModified(local, def.key)
              return (
                <SettingRow
                  def={def}
                  disabled={save.isPending}
                  key={def.key}
                  modified={modified}
                  onReset={() => resetKey(def)}
                >
                  <SettingControl
                    def={def}
                    disabled={save.isPending}
                    onChange={(next) => scheduleSave(def.key, next)}
                    providers={providers}
                    value={value}
                  />
                </SettingRow>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
