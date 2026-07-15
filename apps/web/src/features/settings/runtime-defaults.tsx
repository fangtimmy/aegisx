import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
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

export function RuntimeDefaults({
  settings,
  providers,
}: {
  settings: SettingsPublic
  providers: ProviderConnection[]
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: Omit<SettingsPublic, "updatedAt">) =>
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
  const modelItems = Object.fromEntries([
    ["", "No default model"],
    ...models.map((model) => [
      model.id,
      `${model.provider.label} / ${model.label}`,
    ]),
  ])
  const defaultModelId = models.some(
    (model) => model.id === settings.defaultModelId
  )
    ? settings.defaultModelId
    : ""
  return (
    <form
      className="grid grid-cols-2 gap-4"
      key={settings.updatedAt}
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        mutation.mutate({
          defaultModelId: String(data.get("defaultModelId")) || null,
          environment: String(data.get("environment")) as "local" | "container",
          containerImage: String(data.get("containerImage")).trim(),
          cpus: Number(data.get("cpus")),
          memoryMb: Number(data.get("memoryMb")),
          pidsLimit: Number(data.get("pidsLimit")),
          maxConcurrency: Number(data.get("maxConcurrency")),
        })
      }}
    >
      <Field className="col-span-2" name="defaultModelId">
        <FieldLabel>Default model</FieldLabel>
        <Select
          defaultValue={defaultModelId}
          items={modelItems}
          name="defaultModelId"
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
      </Field>
      <Field name="environment">
        <FieldLabel>Environment</FieldLabel>
        <Select
          defaultValue={settings.environment}
          items={{ container: "Container", local: "Local" }}
          name="environment"
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="local">Local</SelectItem>
            <SelectItem value="container">Container</SelectItem>
          </SelectPopup>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="runtime-image">Container image</FieldLabel>
        <Input
          defaultValue={settings.containerImage}
          id="runtime-image"
          name="containerImage"
          required
          type="text"
        />
      </Field>
      <Field name="cpus">
        <FieldLabel>CPUs</FieldLabel>
        <NumberField
          defaultValue={settings.cpus}
          max={16}
          min={0.1}
          name="cpus"
          required
          step={0.1}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </Field>
      <Field name="memoryMb">
        <FieldLabel>Memory (MB)</FieldLabel>
        <NumberField
          defaultValue={settings.memoryMb}
          max={32768}
          min={128}
          name="memoryMb"
          required
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </Field>
      <Field name="pidsLimit">
        <FieldLabel>PID limit</FieldLabel>
        <NumberField
          defaultValue={settings.pidsLimit}
          max={4096}
          min={16}
          name="pidsLimit"
          required
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </Field>
      <Field name="maxConcurrency">
        <FieldLabel>Max concurrency</FieldLabel>
        <NumberField
          defaultValue={settings.maxConcurrency}
          max={32}
          min={1}
          name="maxConcurrency"
          required
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
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
