import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import {
  type ConversationToolExpandPrefs,
  keys,
  type ProviderConnection,
  type SettingsPublic,
  settingsApi,
} from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
import { Switch } from "@/components/ui/switch"
import { toast } from "@/lib/toast"
import { NumberFieldControl } from "./number-field-control"

const TOOL_TIMEOUT_FIELDS: Array<[string, string]> = [
  ["bash", "Bash"],
  ["submit_flag", "Submit flag"],
  ["get_target", "Get target"],
  ["start_target", "Start target"],
  ["extend_target", "Extend target"],
  ["stop_target", "Stop target"],
]

type RuntimeSettingsInput = Pick<
  SettingsPublic,
  | "defaultModelId"
  | "defaultThinkingLevel"
  | "environment"
  | "containerImage"
  | "cpus"
  | "memoryMb"
  | "pidsLimit"
  | "maxConcurrency"
  | "maxAttachmentMb"
> & {
  maxRetryAttempts: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  maxToolOutputBytes: number
  maxInlineShellOutputBytes: number
  maxCapturedShellOutputBytes: number
  containerWorkspace: string
  dockerTimeoutMs: number
  tmpfsSize: string
  platformRequestTimeoutMs: number
  providerDiscoverTimeoutMs: number
  defaultToolTimeoutMs: number
  toolTimeouts: Record<string, number>
  conversationToolExpand: ConversationToolExpandPrefs
}

type RuntimeFormValues = {
  defaultModelId: string
  defaultThinkingLevel: string
  environment: "local" | "container"
  containerImage: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  maxConcurrency: number
  maxAttachmentMb: number
  maxRetryAttempts: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  maxToolOutputBytes: number
  maxInlineShellOutputBytes: number
  maxCapturedShellOutputBytes: number
  containerWorkspace: string
  dockerTimeoutMs: number
  tmpfsSize: string
  platformRequestTimeoutMs: number
  providerDiscoverTimeoutMs: number
  defaultToolTimeoutMs: number
  toolTimeouts: Record<string, number>
  conversationToolExpand: ConversationToolExpandPrefs
}

const TOOL_EXPAND_FIELDS: Array<
  [keyof ConversationToolExpandPrefs, string, string]
> = [
  ["fileRead", "File read tools", "read, ls, find, grep while running"],
  ["fileEdit", "File edit tools", "write, edit while running"],
  ["bash", "Bash", "shell commands while running"],
  ["target", "Target control", "start/stop/extend remote targets"],
  ["flag", "Flag & finish", "submit_flag, finish_run"],
  ["agent", "Agent tools", "spawn_agent, inspect_agent, other tools"],
  ["errors", "Failed tools", "expand tools that end in error"],
]

export function RuntimeDefaults({
  settings,
  providers,
}: {
  settings: SettingsPublic
  providers: ProviderConnection[]
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: RuntimeSettingsInput) =>
      settingsApi.updateSettings(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.settings.all })
      toast.success("Settings saved")
    },
    onError: (error) => toast.error("Failed to save settings", error.message),
  })
  const models = providers.flatMap((provider) =>
    provider.enabled && provider.apiKey
      ? provider.models
          .filter((model) => model.enabled)
          .map((model) => ({ ...model, provider }))
      : []
  )
  const defaultModelId =
    models.some((model) => model.id === settings.defaultModelId) &&
    settings.defaultModelId
      ? settings.defaultModelId
      : ""

  const form = useForm<RuntimeFormValues>({
    defaultValues: {
      defaultModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      environment: settings.environment,
      containerImage: settings.containerImage,
      cpus: settings.cpus,
      memoryMb: settings.memoryMb,
      pidsLimit: settings.pidsLimit,
      maxConcurrency: settings.maxConcurrency,
      maxAttachmentMb: settings.maxAttachmentMb,
      maxRetryAttempts: settings.maxRetryAttempts,
      retryBaseDelayMs: settings.retryBaseDelayMs,
      retryMaxDelayMs: settings.retryMaxDelayMs,
      maxToolOutputBytes: settings.maxToolOutputBytes,
      maxInlineShellOutputBytes: settings.maxInlineShellOutputBytes,
      maxCapturedShellOutputBytes: settings.maxCapturedShellOutputBytes,
      containerWorkspace: settings.containerWorkspace,
      dockerTimeoutMs: settings.dockerTimeoutMs,
      tmpfsSize: settings.tmpfsSize,
      platformRequestTimeoutMs: settings.platformRequestTimeoutMs,
      providerDiscoverTimeoutMs: settings.providerDiscoverTimeoutMs,
      defaultToolTimeoutMs: settings.defaultToolTimeoutMs,
      toolTimeouts: { ...settings.toolTimeouts },
      conversationToolExpand: { ...settings.conversationToolExpand },
    },
  })

  return (
    <form
      className="grid grid-cols-2 gap-4"
      key={settings.updatedAt}
      onSubmit={form.handleSubmit((values) =>
        mutation.mutate({
          defaultModelId: values.defaultModelId || null,
          defaultThinkingLevel: values.defaultThinkingLevel as
            | "off"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh"
            | "max",
          environment: values.environment,
          containerImage: values.containerImage.trim(),
          cpus: values.cpus,
          memoryMb: values.memoryMb,
          pidsLimit: values.pidsLimit,
          maxConcurrency: values.maxConcurrency,
          maxAttachmentMb: values.maxAttachmentMb,
          maxRetryAttempts: values.maxRetryAttempts,
          retryBaseDelayMs: values.retryBaseDelayMs,
          retryMaxDelayMs: values.retryMaxDelayMs,
          maxToolOutputBytes: values.maxToolOutputBytes,
          maxInlineShellOutputBytes: values.maxInlineShellOutputBytes,
          maxCapturedShellOutputBytes: values.maxCapturedShellOutputBytes,
          containerWorkspace: values.containerWorkspace,
          dockerTimeoutMs: values.dockerTimeoutMs,
          tmpfsSize: values.tmpfsSize,
          platformRequestTimeoutMs: values.platformRequestTimeoutMs,
          providerDiscoverTimeoutMs: values.providerDiscoverTimeoutMs,
          defaultToolTimeoutMs: values.defaultToolTimeoutMs,
          toolTimeouts: values.toolTimeouts,
          conversationToolExpand: values.conversationToolExpand,
        })
      )}
    >
      <Field className="col-span-2">
        <FieldLabel>Default model</FieldLabel>
        <Controller
          control={form.control}
          name="defaultModelId"
          render={({ field }) => (
            <Select
              items={Object.fromEntries([
                ["", "No default model"],
                ...models.map((model) => [
                  model.id,
                  `${model.provider.label} / ${model.label}`,
                ]),
              ])}
              onValueChange={field.onChange}
              value={field.value}
            >
              <SelectTrigger>
                <SelectValue placeholder="No default model" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">No default model</SelectItem>
                {providers.map((provider) => {
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
          )}
        />
      </Field>
      <Field>
        <FieldLabel>Default reasoning level</FieldLabel>
        <Controller
          control={form.control}
          name="defaultThinkingLevel"
          render={({ field }) => (
            <Select
              items={{
                off: "Off",
                minimal: "Minimal",
                low: "Low",
                medium: "Medium",
                high: "High",
                xhigh: "Extra high",
                max: "Maximum",
              }}
              onValueChange={field.onChange}
              value={field.value}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="minimal">Minimal</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="xhigh">Extra high</SelectItem>
                <SelectItem value="max">Maximum</SelectItem>
              </SelectPopup>
            </Select>
          )}
        />
      </Field>
      <Field>
        <FieldLabel>Environment</FieldLabel>
        <Controller
          control={form.control}
          name="environment"
          render={({ field }) => (
            <Select
              items={{ container: "Container", local: "Local" }}
              onValueChange={(value) =>
                field.onChange(value as "local" | "container")
              }
              value={field.value}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="container">Container</SelectItem>
              </SelectPopup>
            </Select>
          )}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="runtime-image">Container image</FieldLabel>
        <Controller
          control={form.control}
          name="containerImage"
          render={({ field }) => (
            <Input
              id="runtime-image"
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
      <NumberFieldControl
        control={form.control}
        label="CPUs"
        max={16}
        min={0.1}
        name="cpus"
        step={0.1}
      />
      <NumberFieldControl
        control={form.control}
        label="Memory (MB)"
        max={32768}
        min={128}
        name="memoryMb"
      />
      <NumberFieldControl
        control={form.control}
        label="PID limit"
        max={4096}
        min={16}
        name="pidsLimit"
      />
      <NumberFieldControl
        control={form.control}
        label="Max active agents"
        max={32}
        min={1}
        name="maxConcurrency"
      />
      <NumberFieldControl
        control={form.control}
        label="Max attachment size (MiB)"
        max={10240}
        min={1}
        name="maxAttachmentMb"
      />
      <Field className="col-span-2">
        <FieldLabel htmlFor="runtime-workspace">
          Container workspace path
        </FieldLabel>
        <Controller
          control={form.control}
          name="containerWorkspace"
          render={({ field }) => (
            <Input
              id="runtime-workspace"
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
      <NumberFieldControl
        control={form.control}
        label="Max retry attempts"
        max={20}
        min={0}
        name="maxRetryAttempts"
      />
      <NumberFieldControl
        control={form.control}
        label="Retry base delay (ms)"
        max={120000}
        min={0}
        name="retryBaseDelayMs"
      />
      <NumberFieldControl
        control={form.control}
        label="Retry max delay (ms)"
        max={600000}
        min={0}
        name="retryMaxDelayMs"
      />
      <NumberFieldControl
        control={form.control}
        label="Tool output limit (bytes)"
        max={1_000_000}
        min={1000}
        name="maxToolOutputBytes"
      />
      <NumberFieldControl
        control={form.control}
        label="Inline shell output (bytes)"
        max={500_000}
        min={1000}
        name="maxInlineShellOutputBytes"
      />
      <NumberFieldControl
        control={form.control}
        label="Captured shell output (bytes)"
        max={50_000_000}
        min={10_000}
        name="maxCapturedShellOutputBytes"
      />
      <NumberFieldControl
        control={form.control}
        label="Docker command timeout (ms)"
        max={300_000}
        min={1000}
        name="dockerTimeoutMs"
      />
      <Field>
        <FieldLabel htmlFor="runtime-tmpfs">Tmpfs size</FieldLabel>
        <Controller
          control={form.control}
          name="tmpfsSize"
          render={({ field }) => (
            <Input
              id="runtime-tmpfs"
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
      <NumberFieldControl
        control={form.control}
        label="Platform request timeout (ms)"
        max={300_000}
        min={1000}
        name="platformRequestTimeoutMs"
      />
      <NumberFieldControl
        control={form.control}
        label="Provider discover timeout (ms)"
        max={120_000}
        min={1000}
        name="providerDiscoverTimeoutMs"
      />
      <NumberFieldControl
        control={form.control}
        label="Default tool timeout (ms)"
        max={600_000}
        min={1000}
        name="defaultToolTimeoutMs"
      />
      {TOOL_TIMEOUT_FIELDS.map(([key, label]) => (
        <NumberFieldControl
          control={form.control}
          key={key}
          label={`${label} timeout (ms)`}
          max={600_000}
          min={1000}
          name={`toolTimeouts.${key}`}
        />
      ))}
      <div className="col-span-2 grid gap-3 rounded-lg border p-4">
        <div>
          <h3 className="font-medium text-sm">Conversation tool panels</h3>
          <p className="text-muted-foreground text-xs">
            Auto-expand tool I/O while running (or on error). Default is
            collapsed for every category.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TOOL_EXPAND_FIELDS.map(([key, label, description]) => (
            <Field
              className="flex flex-row items-start justify-between gap-3"
              key={key}
            >
              <div className="min-w-0">
                <FieldLabel className="font-normal">{label}</FieldLabel>
                <p className="text-muted-foreground text-xs">{description}</p>
              </div>
              <Controller
                control={form.control}
                name={`conversationToolExpand.${key}`}
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </Field>
          ))}
        </div>
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <Button loading={mutation.isPending} type="submit">
          Save defaults
        </Button>
        {mutation.error && (
          <Alert variant="error">
            <CircleAlert />
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
    </form>
  )
}
