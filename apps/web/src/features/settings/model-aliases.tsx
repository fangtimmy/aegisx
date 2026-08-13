import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Pencil, Plus, Tags, Trash2 } from "lucide-react"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"

import {
  aliasesApi,
  keys,
  providersApi,
  type ModelAlias,
  type PatchAliasInput,
  type ProviderConnection,
  type ThinkingLevel,
} from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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

const THINKING_LEVELS = Object.keys(thinkingLevelLabels) as ThinkingLevel[]

/** Flattened enabled models for the per-alias model picker. */
function enabledModels(providers: ProviderConnection[]) {
  return providers
    .filter((p) => p.enabled && p.apiKey)
    .flatMap((p) =>
      p.models.filter((m) => m.enabled).map((m) => ({ provider: p, model: m }))
    )
}

/** Friendly label for an alias's first (current) model id, or "未设置". */
function aliasModelLabel(
  alias: ModelAlias,
  providers: ProviderConnection[]
): string {
  const models = enabledModels(providers)
  for (const id of alias.modelIds) {
    const entry = models.find((m) => m.model.id === id)
    if (entry) return `${entry.provider.label} / ${entry.model.label}`
  }
  // Fall back to any model that exists at all (even disabled) for context.
  for (const id of alias.modelIds) {
    const entry = providers
      .flatMap((p) => p.models.map((m) => ({ provider: p, model: m })))
      .find((m) => m.model.id === id)
    if (entry) return `${entry.provider.label} / ${entry.model.label}（未启用）`
  }
  return "未设置"
}

export function ModelAliases() {
  const queryClient = useQueryClient()
  const aliases = useQuery({
    queryKey: keys.aliases.all,
    queryFn: () => aliasesApi.listAliases(),
  })
  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: keys.aliases.all })

  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchAliasInput }) =>
      aliasesApi.updateAlias(id, patch),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error("保存别名失败", error.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) => aliasesApi.deleteAlias(id),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error("删除别名失败", error.message),
  })

  const items = aliases.data?.items ?? []
  const providerItems = providers.data?.items ?? []

  return (
    <CardFrame className="min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex items-center gap-2">
            模型别名
            <Badge variant="secondary">{items.length}</Badge>
          </span>
        </CardFrameTitle>
        <CardFrameDescription>
          为「模型 + 推理强度」组合起一个简短名字（如 high / medium /
          low）。默认模型与调度者模型引用别名时，重指向会全局生效；其余选择器把别名当作快捷入口。
        </CardFrameDescription>
        <CardFrameAction>
          <CreateAliasDialog onCreated={() => void invalidate()} />
        </CardFrameAction>
      </CardFrameHeader>
      <Card>
        <CardPanel className="flex flex-col gap-4">
          {aliases.error && (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>{aliases.error.message}</AlertDescription>
            </Alert>
          )}
          {patch.error && (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>{patch.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="divide-y">
            {items.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyTitle>未配置别名</EmptyTitle>
                  <EmptyDescription>
                    添加一个别名以快速选择常用模型与推理强度。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              items.map((alias) => (
                <div className="flex items-center gap-3 py-3" key={alias.id}>
                  <AliasName
                    alias={alias}
                    disabled={patch.isPending}
                    providers={providerItems}
                    onRename={(label) =>
                      patch.mutate({ id: alias.id, patch: { label } })
                    }
                  />
                  <AliasModelSelect
                    alias={alias}
                    providers={providerItems}
                    disabled={patch.isPending}
                    onChange={(modelId) =>
                      patch.mutate({
                        id: alias.id,
                        patch: { modelIds: [modelId] },
                      })
                    }
                  />
                  <AliasThinkingSelect
                    alias={alias}
                    disabled={patch.isPending}
                    onChange={(thinkingLevel) =>
                      patch.mutate({ id: alias.id, patch: { thinkingLevel } })
                    }
                  />
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          aria-label={`删除 ${alias.label}`}
                          size="icon"
                          title="删除别名"
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      <Trash2 />
                    </AlertDialogTrigger>
                    <AlertDialogPopup>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          删除 {alias.label}？
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          引用此别名的默认模型将变为无效，需重新选择。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogClose
                          render={<Button type="button" variant="ghost" />}
                        >
                          取消
                        </AlertDialogClose>
                        <Button
                          loading={
                            remove.isPending && remove.variables === alias.id
                          }
                          onClick={() => remove.mutate(alias.id)}
                          type="button"
                          variant="destructive"
                        >
                          删除别名
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogPopup>
                  </AlertDialog>
                </div>
              ))
            )}
          </div>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** The alias name — prominent, click-to-rename inline. Secondary line shows the
 * currently bound model + thinking summary. */
function AliasName({
  alias,
  providers,
  disabled,
  onRename,
}: {
  alias: ModelAlias
  providers: ProviderConnection[]
  disabled?: boolean
  onRename: (label: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(alias.label)
  const [nameError, setNameError] = useState<string | null>(null)

  const start = () => {
    setDraft(alias.label)
    setNameError(null)
    setEditing(true)
  }
  const commit = () => {
    const label = draft.trim()
    if (!label) {
      setNameError("名称不能为空")
      return
    }
    if (label !== alias.label) onRename(label)
    setEditing(false)
  }

  return (
    <div className="min-w-0 flex-1">
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            commit()
          }}
        >
          <Input
            autoFocus
            className="h-8 w-44"
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false)
            }}
            value={draft}
          />
          <Button disabled={disabled} size="sm" type="submit">
            保存
          </Button>
          <Button
            onClick={() => setEditing(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            取消
          </Button>
          {nameError && (
            <span className="text-xs text-destructive">{nameError}</span>
          )}
        </form>
      ) : (
        <button
          aria-label={`重命名 ${alias.label}`}
          className="group flex min-w-0 items-center gap-2 text-left"
          onClick={start}
          title="点击重命名"
          type="button"
        >
          <Tags aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-semibold">
            {alias.label}
          </span>
          <Pencil
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </button>
      )}
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {aliasModelLabel(alias, providers)}
        {alias.thinkingLevel !== "off" &&
          ` · 推理 ${thinkingLevelLabels[alias.thinkingLevel]}`}
      </p>
    </div>
  )
}

/** Inline model picker for one alias — sets a single model (v1). */
function AliasModelSelect({
  alias,
  providers,
  disabled,
  onChange,
}: {
  alias: ModelAlias
  providers: ProviderConnection[]
  disabled?: boolean
  onChange: (modelId: string) => void
}) {
  const models = enabledModels(providers)
  // Current value: first alias model id that exists (enabled or not), so the
  // select shows the configured model even when it is currently disabled.
  const current =
    alias.modelIds.find((id) => models.some((m) => m.model.id === id)) ??
    alias.modelIds[0] ??
    ""
  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ provider: p, model: m }))
  )
  return (
    <Select
      disabled={disabled}
      items={Object.fromEntries(
        allModels.map((m) => [
          m.model.id,
          `${m.provider.label} / ${m.model.label}`,
        ])
      )}
      onValueChange={(value) => value && onChange(value)}
      value={current}
    >
      <SelectTrigger className="h-8 min-w-[13rem] text-xs">
        <SelectValue placeholder="选择模型" />
      </SelectTrigger>
      <SelectPopup>
        {providers.map((provider) => {
          const providerModels = models.filter(
            (m) => m.provider.id === provider.id
          )
          if (providerModels.length === 0) return null
          return (
            <SelectGroup key={provider.id}>
              <SelectGroupLabel>{provider.label}</SelectGroupLabel>
              {providerModels.map((m) => (
                <SelectItem key={m.model.id} value={m.model.id}>
                  {m.model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
      </SelectPopup>
    </Select>
  )
}

/** Inline reasoning-level picker for one alias. */
function AliasThinkingSelect({
  alias,
  disabled,
  onChange,
}: {
  alias: ModelAlias
  disabled?: boolean
  onChange: (thinkingLevel: ThinkingLevel) => void
}) {
  return (
    <Select
      disabled={disabled}
      items={Object.fromEntries(
        THINKING_LEVELS.map((level) => [level, thinkingLevelLabels[level]])
      )}
      onValueChange={(value) => value && onChange(value as ThinkingLevel)}
      value={alias.thinkingLevel}
    >
      <SelectTrigger className="h-8 w-[8.5rem] text-xs">
        <SelectValue placeholder="推理" />
      </SelectTrigger>
      <SelectPopup>
        {THINKING_LEVELS.map((level) => (
          <SelectItem key={level} value={level}>
            {thinkingLevelLabels[level]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

type CreateAliasForm = {
  label: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

function CreateAliasDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })
  const models = enabledModels(providers.data?.items ?? [])
  const form = useForm<CreateAliasForm>({
    defaultValues: {
      label: "",
      modelId: models[0]?.model.id ?? "",
      thinkingLevel: "off",
    },
  })
  const mutation = useMutation({
    mutationFn: (values: CreateAliasForm) =>
      aliasesApi.createAlias({
        label: values.label.trim(),
        modelIds: [values.modelId],
        thinkingLevel: values.thinkingLevel,
      }),
    onSuccess: () => {
      onCreated()
      setOpen(false)
      form.reset({
        label: "",
        modelId: models[0]?.model.id ?? "",
        thinkingLevel: "off",
      })
    },
    onError: (error) => toast.error("创建别名失败", error.message),
  })

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          form.reset({
            label: "",
            modelId: models[0]?.model.id ?? "",
            thinkingLevel: "off",
          })
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button type="button" />}>
        <Plus /> 添加别名
      </DialogTrigger>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>添加模型别名</DialogTitle>
          <DialogDescription>
            为一个「模型 + 推理强度」组合起一个简短名字。
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={form.handleSubmit((values) => {
            if (!values.modelId) return
            mutation.mutate(values)
          })}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="alias-label">名称</FieldLabel>
              <Controller
                control={form.control}
                name="label"
                render={({ field }) => (
                  <Input
                    autoFocus
                    id="alias-label"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="例如 high"
                    required
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="alias-model">模型</FieldLabel>
              <Controller
                control={form.control}
                name="modelId"
                render={({ field }) => (
                  <Select
                    items={Object.fromEntries(
                      models.map((m) => [
                        m.model.id,
                        `${m.provider.label} / ${m.model.label}`,
                      ])
                    )}
                    onValueChange={(value) => field.onChange(value ?? "")}
                    value={field.value}
                  >
                    <SelectTrigger id="alias-model">
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectPopup>
                      {providers.data?.items
                        ?.filter((p) => p.enabled && p.apiKey)
                        .map((provider) => {
                          const providerModels = models.filter(
                            (m) => m.provider.id === provider.id
                          )
                          if (providerModels.length === 0) return null
                          return (
                            <SelectGroup key={provider.id}>
                              <SelectGroupLabel>
                                {provider.label}
                              </SelectGroupLabel>
                              {providerModels.map((m) => (
                                <SelectItem key={m.model.id} value={m.model.id}>
                                  {m.model.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )
                        })}
                    </SelectPopup>
                  </Select>
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="alias-thinking">推理强度</FieldLabel>
              <Controller
                control={form.control}
                name="thinkingLevel"
                render={({ field }) => (
                  <Select
                    items={Object.fromEntries(
                      THINKING_LEVELS.map((level) => [
                        level,
                        thinkingLevelLabels[level],
                      ])
                    )}
                    onValueChange={(value) =>
                      field.onChange((value ?? "off") as ThinkingLevel)
                    }
                    value={field.value}
                  >
                    <SelectTrigger id="alias-thinking">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {THINKING_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {thinkingLevelLabels[level]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              />
            </Field>
            {models.length === 0 && (
              <Alert variant="warning">
                <CircleAlert />
                <AlertDescription>
                  没有已启用的模型。请先配置并启用一个模型。
                </AlertDescription>
              </Alert>
            )}
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
              disabled={models.length === 0}
              loading={mutation.isPending}
              type="submit"
            >
              添加别名
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
