import { useMutation, useQueryClient } from "@tanstack/react-query"
import { BookOpen, Braces, Eye, RotateCcw, Search } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import {
  type FlatSettings,
  isSettingModified,
  keys,
  type ProviderConnection,
  SETTINGS_DEFS,
  type SettingDef,
  type SettingKey,
  type SettingsResponse,
  settingsApi,
} from "@/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu"
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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

const PROMPT_KIND: Record<
  string,
  "mainSystemPrompt" | "childSystemPrompt" | "initialPrompt"
> = {
  "prompts.mainSystem": "mainSystemPrompt",
  "prompts.childSystem": "childSystemPrompt",
  "prompts.initial": "initialPrompt",
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
    <div className="flex h-7 w-7 shrink-0 items-center justify-center">
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
      <div className="font-medium text-sm leading-7">{def.title}</div>
      {def.description && (
        <p className="text-muted-foreground text-xs leading-snug">
          {def.description}
        </p>
      )}
      <code className="block text-[11px] text-muted-foreground leading-snug">
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
  const fullWidth = def.widget === "prompt"
  const gutter = (
    <div
      aria-hidden
      className={cn(
        "min-h-7 self-stretch rounded-e-sm",
        modified ? "bg-primary" : "bg-transparent"
      )}
    />
  )

  if (fullWidth) {
    return (
      <div className="grid grid-cols-[2px_minmax(0,1fr)_1.75rem] items-start gap-x-3 gap-y-1.5 py-2 pr-2">
        <div className="row-span-2">{gutter}</div>
        <SettingMeta def={def} />
        <ResetSlot disabled={disabled} modified={modified} onReset={onReset} />
        <div className="col-span-2 col-start-2 min-w-0">{children}</div>
      </div>
    )
  }

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
    const models = (providers ?? []).flatMap((provider) =>
      provider.enabled && provider.apiKey
        ? provider.models
            .filter((model) => model.enabled)
            .map((model) => ({ ...model, provider }))
        : []
    )
    const current = typeof value === "string" ? value : ""
    return (
      <Select
        disabled={disabled}
        items={Object.fromEntries([
          ["", "无默认模型"],
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

function PromptControl({
  def,
  value,
  disabled,
  onChange,
  variables,
}: {
  def: SettingDef
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  variables: string[]
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const preview = useMutation({
    mutationFn: (template: string) =>
      settingsApi.previewPrompts({
        kind: PROMPT_KIND[def.key] ?? "mainSystemPrompt",
        template,
      }),
  })

  function insertVariable(variable: string) {
    const textarea = ref.current
    const start = textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? value.length
    const token = `{{${variable}}}`
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Menu>
          <MenuTrigger
            render={<Button type="button" variant="outline" size="sm" />}
          >
            <Braces /> 变量
          </MenuTrigger>
          <MenuPopup align="end" className="max-h-72">
            {variables.map((variable) => (
              <MenuItem key={variable} onClick={() => insertVariable(variable)}>
                <code>{`{{${variable}}}`}</code>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <Button
          disabled={disabled}
          loading={preview.isPending}
          onClick={() => {
            setPreviewOpen(true)
            preview.mutate(value)
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Eye /> 预览
        </Button>
        <Dialog>
          <DialogTrigger
            render={<Button type="button" variant="ghost" size="sm" />}
          >
            <BookOpen /> 语法
          </DialogTrigger>
          <DialogPopup className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Handlebars 模板语法</DialogTitle>
              <DialogDescription>
                留空即保存为空（不回退到内置默认值）。使用「重置」可恢复默认模板。
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="text-sm">
              <p className="text-muted-foreground">
                使用「变量」菜单中的 {"{{variable}}"} 占位符。
              </p>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </div>
      <Textarea
        className="[&_textarea]:max-h-64 [&_textarea]:min-h-32 [&_textarea]:overflow-y-auto [&_textarea]:font-mono [&_textarea]:text-xs"
        disabled={disabled}
        maxLength={100_000}
        onChange={(event) => onChange(event.target.value)}
        ref={ref}
        value={value}
      />
      <Dialog
        onOpenChange={(open) => {
          setPreviewOpen(open)
          if (!open) preview.reset()
        }}
        open={previewOpen}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>预览：{def.title}</DialogTitle>
            <DialogDescription>带高亮替换内容的示例上下文。</DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[60vh] overflow-auto whitespace-pre-wrap font-mono text-xs">
            {preview.error && (
              <p className="text-destructive">{preview.error.message}</p>
            )}
            {preview.data?.segments.map((segment) => (
              <span
                className={segment.highlighted ? "bg-primary/20" : undefined}
                key={segment.id}
              >
                {segment.text}
              </span>
            ))}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
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
        <p className="text-muted-foreground text-sm">没有匹配的设置项。</p>
      )}
      {groups.map(([group, defs]) => (
        <section key={group}>
          <h2 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {group}
          </h2>
          <div className="divide-y overflow-hidden rounded-lg border">
            {defs.map((def) => {
              const value = local[def.key]
              const modified = isSettingModified(local, def.key)
              if (def.widget === "prompt") {
                return (
                  <SettingRow
                    def={def}
                    disabled={save.isPending}
                    key={def.key}
                    modified={modified}
                    onReset={() => resetKey(def)}
                  >
                    <PromptControl
                      def={def}
                      disabled={save.isPending}
                      onChange={(next) => scheduleSave(def.key, next)}
                      value={typeof value === "string" ? value : ""}
                      variables={data.meta.promptVariables}
                    />
                  </SettingRow>
                )
              }
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
