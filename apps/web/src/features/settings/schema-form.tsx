import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RotateCcw, Search } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import {
  type FlatSettings,
  isSettingModified,
  keys,
  SETTINGS_DEFS,
  type SettingDef,
  type SettingKey,
  type SettingsResponse,
  settingsApi,
} from "@/api"
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
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import { ModelRefPicker } from "../runs/model-switcher"

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

function SettingControl({
  def,
  value,
  disabled,
  onChange,
}: {
  def: SettingDef
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
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
      <ModelRefPicker
        disabled={disabled}
        emptyLabel="无默认模型"
        onChange={(next) => onChange(next)}
        value={typeof value === "string" ? value : null}
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

export function SchemaSettingsForm({ data }: { data: SettingsResponse }) {
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
