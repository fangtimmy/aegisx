import { useMutation } from "@tanstack/react-query"
import { CircleAlert, Eye, EyeOff, Trash2 } from "lucide-react"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"

import { providersApi, type ProviderConnection } from "@/api"
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
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFooter,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

import { providerTypeLabels } from "./provider-config"
import { ProviderTypeField } from "./provider-dialog"
import { ProviderModels } from "./provider-models"
import { useProviderEditor } from "./use-provider-editor"

type ProviderFormValues = {
  label: string
  type: ProviderConnection["type"]
  baseUrl: string
  apiKey: string
}

type TestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; message: string }

/** Model dropdown + 「测试对话」button + result line — one max_tokens=1 probe
 * against the SAVED provider config (unsaved form edits do not apply). */
function ProviderTestPanel({ provider }: { provider: ProviderConnection }) {
  const [modelId, setModelId] = useState(provider.models[0]?.modelId ?? "")
  const [result, setResult] = useState<TestResult | null>(null)
  const test = useMutation({
    mutationFn: () => providersApi.testProviderModel(provider.id, modelId),
    onSuccess: (outcome) => setResult(outcome),
    onError: (error: Error) => setResult({ ok: false, message: error.message }),
  })
  const models = Object.fromEntries(
    provider.models.map((model) => [model.modelId, model.label])
  )
  return (
    <div className="col-span-2 flex flex-wrap items-center gap-2 border-t pt-4">
      <Select
        disabled={provider.models.length === 0}
        items={models}
        onValueChange={(value) => value && setModelId(value)}
        value={modelId}
      >
        <SelectTrigger className="h-8 w-56" size="sm">
          <SelectValue placeholder="选择模型" />
        </SelectTrigger>
        <SelectPopup>
          {provider.models.map((model) => (
            <SelectItem key={model.modelId} value={model.modelId}>
              {model.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        disabled={!modelId}
        loading={test.isPending}
        onClick={() => test.mutate()}
        size="sm"
        title={
          provider.models.length === 0
            ? "先添加模型后再测试"
            : "发送一次 max_tokens=1 对话验证整条链路"
        }
        type="button"
        variant="outline"
      >
        测试对话
      </Button>
      {result && (
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            result.ok ? "text-muted-foreground" : "text-destructive"
          )}
        >
          {result.ok ? `✓ ${result.latencyMs}ms` : `✗ ${result.message}`}
        </span>
      )}
    </div>
  )
}

export function ProviderDetail({
  provider,
  onDelete,
  deleteError,
  deletePending,
}: {
  provider: ProviderConnection
  onDelete: () => void
  deleteError?: Error | null
  deletePending: boolean
}) {
  const editor = useProviderEditor(provider)
  const { save, setShowKey, showKey } = editor
  const form = useForm<ProviderFormValues>({
    defaultValues: {
      label: provider.label,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>供应商配置</CardFrameTitle>
          <CardFrameDescription>
            {providerTypeLabels[provider.type]}
          </CardFrameDescription>
          <CardFrameAction>
            <Switch
              aria-label={provider.enabled ? "禁用供应商" : "启用供应商"}
              checked={provider.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) =>
                save.mutate({
                  label: form.getValues("label"),
                  type: form.getValues("type"),
                  baseUrl: form.getValues("baseUrl"),
                  apiKey: form.getValues("apiKey").trim() || undefined,
                  enabled: enabled === true,
                })
              }
            />
          </CardFrameAction>
        </CardFrameHeader>
        <Card
          render={
            <form
              onSubmit={form.handleSubmit((values) =>
                save.mutate({
                  label: values.label.trim(),
                  type: values.type,
                  baseUrl: values.baseUrl.trim(),
                  apiKey: values.apiKey.trim() || undefined,
                  enabled: provider.enabled,
                })
              )}
            />
          }
        >
          <CardPanel className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="selected-provider-name">名称</FieldLabel>
              <Controller
                control={form.control}
                name="label"
                render={({ field }) => (
                  <Input
                    id="selected-provider-name"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    required
                    type="text"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <ProviderTypeField
                  onChange={field.onChange}
                  value={field.value}
                />
              )}
            />
            <Field>
              <FieldLabel htmlFor="selected-provider-base-url">
                Base URL
              </FieldLabel>
              <Controller
                control={form.control}
                name="baseUrl"
                render={({ field }) => (
                  <Input
                    id="selected-provider-base-url"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    required
                    type="url"
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="selected-provider-api-key">
                API key
              </FieldLabel>
              <InputGroup>
                <Controller
                  control={form.control}
                  name="apiKey"
                  render={({ field }) => (
                    <InputGroupInput
                      autoComplete="off"
                      id="selected-provider-api-key"
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      type={showKey ? "text" : "password"}
                      placeholder="留空以保留当前密钥"
                      value={field.value}
                    />
                  )}
                />
                <InputGroupAddon align="inline-end">
                  <Button
                    aria-label={showKey ? "隐藏 API key" : "显示 API key"}
                    onClick={() => setShowKey((value) => !value)}
                    size="icon-sm"
                    title={showKey ? "隐藏 API key" : "显示 API key"}
                    type="button"
                    variant="ghost"
                  >
                    {showKey ? <EyeOff /> : <Eye />}
                  </Button>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            {save.error && (
              <Alert className="col-span-2" variant="error">
                <CircleAlert />
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            {deleteError && (
              <Alert className="col-span-2" variant="error">
                <CircleAlert />
                <AlertDescription>{deleteError.message}</AlertDescription>
              </Alert>
            )}
            <ProviderTestPanel provider={provider} />
          </CardPanel>
          <CardFooter className="flex-wrap gap-2">
            <Button loading={save.isPending} type="submit">
              保存供应商
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button type="button" variant="outline" />}
              >
                <Trash2 /> 删除供应商
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除 {provider.label}？</AlertDialogTitle>
                  <AlertDialogDescription>
                    这将永久删除该供应商及其模型。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    取消
                  </AlertDialogClose>
                  <Button
                    disabled={deletePending}
                    loading={deletePending}
                    onClick={onDelete}
                    type="button"
                    variant="destructive"
                  >
                    删除供应商
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </CardFooter>
        </Card>
      </CardFrame>
      <ProviderModels editor={editor} provider={provider} />
    </div>
  )
}
