import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
import {
  apiRequest,
  jsonRequest,
  type ProviderConnection,
  type SettingsPublic,
} from "@/lib/api"

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
>

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
}

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
      apiRequest<SettingsPublic>("/settings", jsonRequest("PATCH", input)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
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
      <Field>
        <FieldLabel>CPUs</FieldLabel>
        <Controller
          control={form.control}
          name="cpus"
          render={({ field }) => (
            <NumberField
              max={16}
              min={0.1}
              onValueChange={field.onChange}
              required
              step={0.1}
              value={field.value}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          )}
          rules={{ required: true, min: 0.1, max: 16 }}
        />
      </Field>
      <Field>
        <FieldLabel>Memory (MB)</FieldLabel>
        <Controller
          control={form.control}
          name="memoryMb"
          render={({ field }) => (
            <NumberField
              max={32768}
              min={128}
              onValueChange={field.onChange}
              required
              value={field.value}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          )}
          rules={{ required: true, min: 128, max: 32768 }}
        />
      </Field>
      <Field>
        <FieldLabel>PID limit</FieldLabel>
        <Controller
          control={form.control}
          name="pidsLimit"
          render={({ field }) => (
            <NumberField
              max={4096}
              min={16}
              onValueChange={field.onChange}
              required
              value={field.value}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          )}
          rules={{ required: true, min: 16, max: 4096 }}
        />
      </Field>
      <Field>
        <FieldLabel>Max active agents</FieldLabel>
        <Controller
          control={form.control}
          name="maxConcurrency"
          render={({ field }) => (
            <NumberField
              max={32}
              min={1}
              onValueChange={field.onChange}
              required
              value={field.value}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          )}
          rules={{ required: true, min: 1, max: 32 }}
        />
      </Field>
      <Field>
        <FieldLabel>Max attachment size (MiB)</FieldLabel>
        <Controller
          control={form.control}
          name="maxAttachmentMb"
          render={({ field }) => (
            <NumberField
              max={10240}
              min={1}
              onValueChange={field.onChange}
              required
              value={field.value}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          )}
          rules={{ required: true, min: 1, max: 10240 }}
        />
      </Field>
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
