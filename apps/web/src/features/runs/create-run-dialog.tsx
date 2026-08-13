import { aliasRef, isAliasRef, type ModelAlias } from "@aegisx/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Box,
  CircleAlert,
  ListOrdered,
  Plus,
  TriangleAlert,
} from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Link } from "react-router"

import {
  aliasesApi,
  type Challenge,
  keys,
  orchestrationsApi,
  providersApi,
  runsApi,
  settingsApi,
  type ThinkingLevel,
} from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, type ButtonProps } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
}

/** Orchestration display names for the picker. */
const ORCHESTRATION_LABELS: Record<string, string> = {
  classic: "Classic（单求解者）",
  "observer-solver": "Observer-Solver（求解者 + 观察者）",
  "bootstrap-solver": "Bootstrap-Solver",
  trio: "Trio（三个并行求解者）",
}

const FIELD_LABELS: Record<string, string> = {
  models: "求解者模型",
  observerModel: "观察者模型",
  model: "模型",
  provider: "供应商",
  modelId: "模型 ID",
  thinking: "推理",
}

/** TypeBox JSON schema node as received from GET /api/orchestrations. */
type SchemaNode = {
  type?: string
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  minItems?: number
  maxItems?: number
  enum?: Array<string | number>
  minimum?: number
}

type ModelOption = {
  /** ProviderModel.id (UUID) — used to resolve alias refs. */
  id: string
  provider: string
  modelId: string
  label: string
}

type CreateRunDialogProps = {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  trigger?: ReactNode
  triggerClassName?: string
  triggerLabel?: string
  triggerSize?: ButtonProps["size"]
  triggerVariant?: ButtonProps["variant"]
  onCreated?: () => void
}

const MODEL_KEY_SEP = "\u0000"

export function CreateRunDialog({
  challenges,
  challenge,
  trigger,
  triggerClassName,
  triggerLabel,
  triggerSize,
  triggerVariant,
  onCreated,
}: CreateRunDialogProps) {
  const [open, setOpen] = useState(false)
  const available = challenge ? [challenge] : (challenges ?? [])

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={
          trigger
            ? (triggerLabel ??
              (challenge ? `为 ${challenge.name} 启动任务` : "启动任务"))
            : undefined
        }
        render={
          <Button
            className={triggerClassName}
            disabled={available.length === 0}
            // Only force an icon size when the caller asks for one; a custom
            // trigger without a size should render as a normal button so the
            // caller can drive width/height via triggerClassName (icon-xs
            // would otherwise lock the button to a fixed square and clip the
            // content — tailwind-merge won't override size-* with w/h-*).
            size={trigger ? triggerSize : undefined}
            type="button"
            variant={trigger ? triggerVariant : undefined}
          />
        }
      >
        {trigger ?? (
          <>
            <Plus /> 启动任务
          </>
        )}
      </DialogTrigger>
      {open ? (
        <CreateRunDialogContent
          challenge={challenge}
          challenges={challenges}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  )
}

function CreateRunDialogContent({
  challenges,
  challenge,
  onCreated,
  onClose,
}: {
  challenges?: Challenge[]
  challenge?: Pick<Challenge, "id" | "name">
  onCreated?: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const available = challenge ? [challenge] : (challenges ?? [])

  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })
  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })
  const orchestrations = useQuery({
    queryKey: ["orchestrations"],
    queryFn: () => orchestrationsApi.listOrchestrations(),
  })

  const [orchestration, setOrchestration] = useState("classic")
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [timeoutMinutes, setTimeoutMinutes] = useState(60)
  const [prompt, setPrompt] = useState("")
  const [challengeId, setChallengeId] = useState(available[0]?.id ?? "")

  const challengePlugins = useMemo(
    () =>
      (orchestrations.data?.items ?? []).filter(
        (plugin) => plugin.scope === "challenge"
      ),
    [orchestrations.data]
  )
  const schema = useMemo(
    () =>
      (challengePlugins.find((plugin) => plugin.id === orchestration)?.params ??
        {}) as SchemaNode,
    [challengePlugins, orchestration]
  )

  // Available models (enabled provider + apiKey + enabled model), grouped for
  // the model-ref pickers.
  const modelOptions = useMemo<ModelOption[]>(() => {
    const options: ModelOption[] = []
    for (const provider of providers.data?.items ?? []) {
      if (!provider.enabled || !provider.apiKey) continue
      for (const model of provider.models) {
        if (!model.enabled) continue
        options.push({
          id: model.id,
          provider: provider.label,
          modelId: model.modelId,
          label: `${provider.label} / ${model.label}`,
        })
      }
    }
    return options
  }, [providers.data])

  const defaultModel = useMemo(
    () => modelOptions[0] ?? { provider: "", modelId: "" },
    [modelOptions]
  )

  // Reset params when the orchestration changes (schema-driven defaults) and
  // seed the timeout from the global default once settings arrive.
  useEffect(() => {
    setParams(buildDefaultParams(schema, defaultModel))
  }, [schema, defaultModel])
  useEffect(() => {
    const defaultMs = settings.data?.settings["scheduler.defaultRunTimeoutMs"]
    if (typeof defaultMs === "number" && defaultMs > 0) {
      setTimeoutMinutes(Math.round(defaultMs / 60_000))
    }
  }, [settings.data])

  const mutation = useMutation({
    mutationFn: () =>
      runsApi.createRun(challenge?.id ?? challengeId, {
        orchestration,
        params,
        timeoutMs: Math.max(1, Math.round(timeoutMinutes)) * 60_000,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      }),
    onSuccess: (item) => {
      toast.success("任务已加入队列")
      void queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(item.eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.runs.byEvent(item.eventId),
      })
      void queryClient.invalidateQueries({
        queryKey: keys.events.detail(item.eventId),
      })
      void queryClient.invalidateQueries({ queryKey: keys.events.all })
      onClose()
      onCreated?.()
    },
    onError: (error) => toast.error("入队失败", error.message),
  })

  const isLoading =
    settings.isPending || providers.isPending || orchestrations.isPending
  const loadError = settings.error ?? providers.error ?? orchestrations.error

  const setParam = (path: string, value: unknown) => {
    setParams((prev) => setNested(prev, path, value))
  }

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>启动任务</DialogTitle>
        <DialogDescription>
          {challenge
            ? `为 ${challenge.name} 选择编排与参数，任务将进入队列。`
            : "选择题目、编排与参数，任务将进入队列。"}
        </DialogDescription>
      </DialogHeader>
      {isLoading && (
        <DialogPanel>
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner aria-hidden="true" />
            正在加载配置…
          </div>
        </DialogPanel>
      )}
      {loadError && (
        <DialogPanel>
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>无法加载任务配置</AlertTitle>
            <AlertDescription>{loadError.message}</AlertDescription>
            <Button
              onClick={() => {
                void settings.refetch()
                void providers.refetch()
                void orchestrations.refetch()
              }}
              type="button"
              variant="outline"
            >
              重试
            </Button>
          </Alert>
        </DialogPanel>
      )}
      {!isLoading && !loadError && (
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            if (!(challenge ?? available[0])) return
            mutation.mutate()
          }}
        >
          <DialogPanel className="grid gap-4">
            {!challenge && (
              <Field>
                <FieldLabel>题目</FieldLabel>
                <Select
                  items={Object.fromEntries(
                    available.map((item) => [item.id, item.name])
                  )}
                  onValueChange={(value) => setChallengeId(value ?? "")}
                  value={challengeId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择题目" />
                  </SelectTrigger>
                  <SelectPopup>
                    {available.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel>编排</FieldLabel>
              <Select
                items={Object.fromEntries(
                  challengePlugins.map((plugin) => [
                    plugin.id,
                    ORCHESTRATION_LABELS[plugin.id] ?? plugin.id,
                  ])
                )}
                onValueChange={(value) => setOrchestration(value ?? "")}
                value={orchestration}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {challengePlugins.map((plugin) => (
                    <SelectItem key={plugin.id} value={plugin.id}>
                      {ORCHESTRATION_LABELS[plugin.id] ?? plugin.id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {modelOptions.length === 0 && hasModelRefs(schema) && (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription>
                  该编排需要模型，但没有已启用的模型。请先到{" "}
                  <Link className="font-medium underline" to="/settings/models">
                    设置 · 模型供应商
                  </Link>{" "}
                  配置并启用一个。
                </AlertDescription>
              </Alert>
            )}
            {renderParamsFields(schema, "", params, setParam, modelOptions)}
            <Field>
              <FieldLabel htmlFor="run-timeout">超时（分钟）</FieldLabel>
              <NumberField
                id="run-timeout"
                min={1}
                onValueChange={(value) => {
                  if (typeof value === "number") setTimeoutMinutes(value)
                }}
                value={timeoutMinutes}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
            <Field>
              <FieldLabel htmlFor="run-prompt">首轮提示词（可选）</FieldLabel>
              <Textarea
                id="run-prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="覆盖编排默认的 initial 提示词…"
                value={prompt}
              />
            </Field>
            <Alert>
              <Box />
              <AlertTitle>容器工具箱</AlertTitle>
              <AlertDescription>
                agent 在宿主机端以进程内方式运行；启动后会拉起一个 Kali
                工具箱容器（<code className="font-mono">sleep infinity</code>
                ），bash 在其中运行，配备完整 CTF
                工具链。任务进入队列后按全局并发上限 （
                <code className="font-mono">调度器 · 最大并发任务数</code>
                ）排队启动。
              </AlertDescription>
            </Alert>
            {mutation.error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </DialogClose>
            <Button
              disabled={modelOptions.length === 0 && hasModelRefs(schema)}
              loading={mutation.isPending}
              type="submit"
            >
              <ListOrdered /> 加入队列
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogPopup>
  )
}

// --- schema-driven params form (spec §11.4) -------------------------------

function hasModelRefs(schema: SchemaNode): boolean {
  if (!schema || schema.type !== "object" || !schema.properties) return false
  if (isModelRefSchema(schema)) return true
  return Object.values(schema.properties).some(
    (child) =>
      (child.type === "array" && child.items && hasModelRefs(child.items)) ||
      hasModelRefs(child)
  )
}

function isModelRefSchema(schema: SchemaNode): boolean {
  const props = schema.properties
  return (
    !!props &&
    typeof props.provider === "object" &&
    typeof props.modelId === "object"
  )
}

function buildDefaultParams(
  schema: SchemaNode,
  defaultModel: ModelOption
): Record<string, unknown> {
  const fill = (node: SchemaNode): unknown => {
    if (!node) return undefined
    if (node.type === "object" && node.properties) {
      if (isModelRefSchema(node)) {
        return {
          provider: defaultModel.provider,
          modelId: defaultModel.modelId,
          thinking: "off",
        }
      }
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node.properties)) {
        result[key] = fill(child)
      }
      return result
    }
    if (node.type === "array" && node.items) {
      const items: SchemaNode = node.items
      const count =
        node.maxItems !== undefined &&
        node.minItems !== undefined &&
        node.maxItems === node.minItems
          ? node.maxItems
          : (node.minItems ?? 1)
      return Array.from({ length: count }, () => fill(items))
    }
    if (node.type === "string") return ""
    if (node.type === "number" || node.type === "integer")
      return node.minimum ?? 0
    if (node.type === "boolean") return false
    return undefined
  }
  const result = fill(schema)
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {}
}

function readNested(params: Record<string, unknown>, path: string): unknown {
  if (!path) return params
  return path
    .split(/[.[\]]+/)
    .filter(Boolean)
    .reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined) return undefined
      if (typeof acc !== "object") return undefined
      return (acc as Record<string, unknown>)[key]
    }, params)
}

function setNested(
  params: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const keys = path.split(/[.[\]]+/).filter(Boolean)
  return {
    ...params,
    [keys[0]]: setAt(params[keys[0]], keys.slice(1), value),
  }
}

function setAt(node: unknown, keys: string[], value: unknown): unknown {
  if (keys.length === 0) return value
  const [head, ...rest] = keys
  if (node === null || node === undefined) {
    // Build the container from the next key: array index → [], else object.
    node = /^\d+$/.test(rest[0] ?? "") ? [] : {}
  }
  if (Array.isArray(node)) {
    const next = [...node]
    const index = Number(head)
    next[index] = setAt(next[index], rest, value)
    return next
  }
  return {
    ...(node as Record<string, unknown>),
    [head]: setAt((node as Record<string, unknown>)[head], rest, value),
  }
}

function renderParamsFields(
  schema: SchemaNode,
  path: string,
  params: Record<string, unknown>,
  setParam: (path: string, value: unknown) => void,
  modelOptions: ModelOption[]
): ReactNode {
  if (!schema) return null
  if (schema.type === "object" && schema.properties) {
    if (isModelRefSchema(schema)) {
      const value = (readNested(params, path) ?? {}) as Record<string, unknown>
      return (
        <ModelRefFields
          modelOptions={modelOptions}
          onChange={(next) => setParam(path, next)}
          value={value}
        />
      )
    }
    return (
      <>
        {Object.entries(schema.properties).map(([key, child]) => (
          <Field key={`${path}.${key}`}>
            <FieldLabel>{FIELD_LABELS[key] ?? key}</FieldLabel>
            {renderParamsFields(
              child,
              path ? `${path}.${key}` : key,
              params,
              setParam,
              modelOptions
            )}
          </Field>
        ))}
      </>
    )
  }
  if (schema.type === "array" && schema.items) {
    const items: SchemaNode = schema.items
    const count =
      schema.maxItems !== undefined &&
      schema.minItems !== undefined &&
      schema.maxItems === schema.minItems
        ? schema.maxItems
        : (schema.minItems ?? 1)
    return (
      <div className="grid gap-2">
        {Array.from({ length: count }, (_, index) => (
          <div className="rounded-md border p-3" key={index}>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              #{index + 1}
            </p>
            {renderParamsFields(
              items,
              `${path}[${index}]`,
              params,
              setParam,
              modelOptions
            )}
          </div>
        ))}
      </div>
    )
  }
  const current = readNested(params, path)
  if (schema.type === "string") {
    if (Array.isArray(schema.enum)) {
      const options = schema.enum.map((value) => String(value))
      const text =
        typeof current === "string"
          ? current
          : options.length > 0
            ? options[0]
            : ""
      return (
        <Select
          items={Object.fromEntries(options.map((value) => [value, value]))}
          onValueChange={(value) => setParam(path, value ?? "")}
          value={text}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {options.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )
    }
    return (
      <Input
        onChange={(event) => setParam(path, event.target.value)}
        type="text"
        value={typeof current === "string" ? current : ""}
      />
    )
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <Input
        min={schema.minimum}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          setParam(path, Number.isFinite(parsed) ? parsed : 0)
        }}
        type="number"
        value={
          typeof current === "number"
            ? String(current)
            : String(schema.minimum ?? 0)
        }
      />
    )
  }
  if (schema.type === "boolean") {
    return (
      <input
        checked={Boolean(current)}
        onChange={(event) => setParam(path, event.target.checked)}
        type="checkbox"
      />
    )
  }
  return null
}

/** Model-ref (provider + modelId + thinking) picker — a leading "别名" group
 * followed by a grouped model select, plus a thinking-level select. Selecting
 * an alias resolves it (now) to a concrete provider/modelId and fills the
 * params snapshot with the alias's reasoning level (run params freeze at
 * creation, so aliases are a convenience here, not a live reference). */
function ModelRefFields({
  value,
  onChange,
  modelOptions,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  modelOptions: ModelOption[]
}) {
  const aliasesQuery = useQuery({
    queryKey: keys.aliases.all,
    queryFn: () => aliasesApi.listAliases(),
  })
  const provider = typeof value.provider === "string" ? value.provider : ""
  const modelId = typeof value.modelId === "string" ? value.modelId : ""
  const thinking =
    typeof value.thinking === "string"
      ? (value.thinking as ThinkingLevel)
      : "off"
  const modelKey = `${provider}${MODEL_KEY_SEP}${modelId}`

  const aliases = aliasesQuery.data?.items ?? []
  const byId = new Map(modelOptions.map((option) => [option.id, option]))

  const selectModel = (key: string) => {
    // An alias ref fills the snapshot with the concrete model + the alias's
    // reasoning level.
    const alias = isAliasRef(key)
      ? aliases.find((a) => aliasRef(a.id) === key)
      : null
    if (alias) {
      for (const id of alias.modelIds) {
        const option = byId.get(id)
        if (option) {
          onChange({
            ...value,
            provider: option.provider,
            modelId: option.modelId,
            thinking: alias.thinkingLevel,
          })
          return
        }
      }
      return
    }
    const [selectedProvider, selectedModelId] = key.split(MODEL_KEY_SEP)
    onChange({ ...value, provider: selectedProvider, modelId: selectedModelId })
  }

  return (
    <div className="grid gap-2">
      <Field>
        <FieldLabel>模型</FieldLabel>
        <Select
          items={Object.fromEntries(
            modelOptions.map((option) => [
              `${option.provider}${MODEL_KEY_SEP}${option.modelId}`,
              option.label,
            ])
          )}
          onValueChange={(key) => {
            if (key) selectModel(key)
          }}
          value={modelKey}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectPopup>
            <AliasModelGroup aliases={aliases} modelOptions={modelOptions} />
            {groupModelOptions(modelOptions).map((group) => (
              <SelectGroup key={group.provider}>
                <SelectGroupLabel>{group.provider}</SelectGroupLabel>
                {group.models.map((option) => (
                  <SelectItem
                    key={`${option.provider}${MODEL_KEY_SEP}${option.modelId}`}
                    value={`${option.provider}${MODEL_KEY_SEP}${option.modelId}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field>
        <FieldLabel>推理</FieldLabel>
        <Select
          items={Object.fromEntries(Object.entries(thinkingLevelLabels))}
          onValueChange={(next) => onChange({ ...value, thinking: next })}
          value={thinking}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(thinkingLevelLabels).map(([level, label]) => (
              <SelectItem key={level} value={level}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
    </div>
  )
}

/** The leading "别名" group for the params model picker. Each alias resolves to
 * the first available model option (matched by ProviderModel.id UUID) and is
 * labeled `alias → model`. Select values are `alias:<id>`; ModelRefFields
 * resolves them (snapshot model + alias thinking) on select. */
function AliasModelGroup({
  aliases,
  modelOptions,
}: {
  aliases: ModelAlias[]
  modelOptions: ModelOption[]
}) {
  const byId = new Map(modelOptions.map((option) => [option.id, option]))
  const resolved = aliases
    .map((alias) => {
      for (const id of alias.modelIds) {
        const option = byId.get(id)
        if (option) return { alias, option }
      }
      return null
    })
    .filter(
      (entry): entry is { alias: ModelAlias; option: ModelOption } =>
        entry !== null
    )
  if (resolved.length === 0) return null
  return (
    <SelectGroup key="aliases">
      <SelectGroupLabel>别名</SelectGroupLabel>
      {resolved.map(({ alias, option }) => (
        <SelectItem key={aliasRef(alias.id)} value={aliasRef(alias.id)}>
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{alias.label}</span>
            <span className="text-muted-foreground">→ {option.label}</span>
            {alias.thinkingLevel !== "off" && (
              <Badge size="sm" variant="secondary">
                {thinkingLevelLabels[alias.thinkingLevel]}
              </Badge>
            )}
          </span>
        </SelectItem>
      ))}
    </SelectGroup>
  )
}

function groupModelOptions(options: ModelOption[]) {
  const groups = new Map<string, ModelOption[]>()
  for (const option of options) {
    const list = groups.get(option.provider) ?? []
    list.push(option)
    groups.set(option.provider, list)
  }
  return [...groups.entries()].map(([provider, models]) => ({
    provider,
    models,
  }))
}
