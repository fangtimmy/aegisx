import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Boxes,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Trash2,
} from "lucide-react"
import { useEffect, useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { CheckboxGroup } from "@/components/ui/checkbox-group"
import {
  Dialog,
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
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
import {
  apiRequest,
  jsonRequest,
  type ProviderConnection,
  type ProviderModel,
  type ProviderType,
  type SettingsPublic,
} from "@/lib/api"

const providerTypeLabels: Record<ProviderType, string> = {
  "openai-compatible": "OpenAI compatible",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
}

const providerTypeDefaults: Record<ProviderType, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
}

const providerTypes = Object.keys(providerTypeLabels) as ProviderType[]

type ProviderInput = Omit<
  ProviderConnection,
  "id" | "models" | "createdAt" | "updatedAt"
>

function ProviderDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ProviderType>("openai-compatible")
  const [label, setLabel] = useState("")
  const [baseUrl, setBaseUrl] = useState(providerTypeDefaults[type])
  const [apiKey, setApiKey] = useState("")
  const mutation = useMutation({
    mutationFn: (input: ProviderInput) =>
      apiRequest<ProviderConnection>("/providers", jsonRequest("POST", input)),
    onSuccess: (provider) => {
      onCreated(provider.id)
      setOpen(false)
      setLabel("")
      setApiKey("")
    },
  })

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" type="button" />}>
        <Plus /> Add provider
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate({
              label: label.trim(),
              type,
              baseUrl: baseUrl.trim(),
              apiKey,
              enabled: true,
            })
          }}
        >
          <DialogPanel className="grid gap-4">
            <ProviderTypeField
              onChange={(next) => {
                setType(next)
                setBaseUrl(providerTypeDefaults[next])
              }}
              value={type}
            />
            <Field>
              <FieldLabel htmlFor="provider-label">Name</FieldLabel>
              <Input
                id="provider-label"
                onChange={(event) => setLabel(event.target.value)}
                required
                value={label}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
              <Input
                id="provider-base-url"
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                type="url"
                value={baseUrl}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
              <Input
                id="provider-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                value={apiKey}
              />
            </Field>
            {mutation.error && (
              <p className="text-destructive text-sm" role="alert">
                {mutation.error.message}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button loading={mutation.isPending} type="submit">
              Add provider
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function ProviderTypeField({
  value,
  onChange,
}: {
  value: ProviderType
  onChange: (value: ProviderType) => void
}) {
  return (
    <Field name="type">
      <FieldLabel>Provider type</FieldLabel>
      <Select
        items={providerTypeLabels}
        name="type"
        onValueChange={(next) => onChange(next as ProviderType)}
        value={value}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {providerTypes.map((type) => (
            <SelectItem key={type} value={type}>
              {providerTypeLabels[type]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  )
}

function ProviderDetail({
  provider,
  settings,
  onDelete,
}: {
  provider: ProviderConnection
  settings: SettingsPublic
  onDelete: () => void
}) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState(provider.label)
  const [type, setType] = useState(provider.type)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState(provider.apiKey)
  const [showKey, setShowKey] = useState(true)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const save = useMutation({
    mutationFn: (input: ProviderInput) =>
      apiRequest<ProviderConnection>(
        `/providers/${provider.id}`,
        jsonRequest("PATCH", input)
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  })
  const discover = useMutation({
    mutationFn: () =>
      apiRequest<{ models: string[] }>(
        `/providers/${provider.id}/models/discover`,
        {
          method: "POST",
        }
      ),
    onSuccess: ({ models }) => {
      const known = new Set(provider.models.map((model) => model.modelId))
      const fresh = models.filter((model) => !known.has(model))
      setDiscovered(fresh)
      setSelected(fresh)
    },
  })
  const addModels = useMutation({
    mutationFn: () =>
      Promise.all(
        selected.map((modelId) =>
          apiRequest<ProviderModel>(
            `/providers/${provider.id}/models`,
            jsonRequest("POST", { modelId, label: modelId })
          )
        )
      ),
    onSuccess: () => {
      setDiscovered(null)
      setSelected([])
      queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
  const modelMutation = useMutation({
    mutationFn: ({ modelId, body }: { modelId: string; body: object }) =>
      apiRequest<ProviderModel>(
        `/provider-models/${modelId}`,
        jsonRequest("PATCH", body)
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  })
  const setDefault = useMutation({
    mutationFn: (defaultModelId: string) =>
      apiRequest<SettingsPublic>(
        "/settings",
        jsonRequest("PATCH", {
          defaultModelId,
          environment: settings.environment,
          containerImage: settings.containerImage,
          cpus: settings.cpus,
          memoryMb: settings.memoryMb,
          pidsLimit: settings.pidsLimit,
          maxConcurrency: settings.maxConcurrency,
        })
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  })

  return (
    <div className="space-y-6">
      <section className="border-b pb-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base">Provider configuration</h2>
            <p className="text-muted-foreground text-sm">
              {providerTypeLabels[provider.type]}
            </p>
          </div>
          <Switch
            aria-label={
              provider.enabled ? "Disable provider" : "Enable provider"
            }
            checked={provider.enabled}
            onCheckedChange={(enabled) =>
              save.mutate({
                label,
                type,
                baseUrl,
                apiKey,
                enabled: enabled === true,
              })
            }
          />
        </div>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate({
              label: label.trim(),
              type,
              baseUrl: baseUrl.trim(),
              apiKey,
              enabled: provider.enabled,
            })
          }}
        >
          <Field>
            <FieldLabel htmlFor="selected-provider-name">Name</FieldLabel>
            <Input
              id="selected-provider-name"
              onChange={(event) => setLabel(event.target.value)}
              required
              value={label}
            />
          </Field>
          <ProviderTypeField onChange={setType} value={type} />
          <Field>
            <FieldLabel htmlFor="selected-provider-base-url">
              Base URL
            </FieldLabel>
            <Input
              id="selected-provider-base-url"
              onChange={(event) => setBaseUrl(event.target.value)}
              required
              type="url"
              value={baseUrl}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="selected-provider-api-key">API key</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="selected-provider-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                type={showKey ? "text" : "password"}
                value={apiKey}
              />
              <InputGroupAddon align="inline-end">
                <Button
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowKey((value) => !value)}
                  size="icon-sm"
                  title={showKey ? "Hide API key" : "Show API key"}
                  type="button"
                  variant="ghost"
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button loading={save.isPending} type="submit">
              Save provider
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button type="button" variant="outline" />}
              >
                <Trash2 /> Delete provider
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {provider.label}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the provider and its models.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    onClick={onDelete}
                    type="button"
                    variant="destructive"
                  >
                    Delete provider
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </div>
          {save.error && (
            <p className="text-destructive text-sm sm:col-span-2" role="alert">
              {save.error.message}
            </p>
          )}
        </form>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base">Models</h2>
            <p className="text-muted-foreground text-sm">
              Only enabled models can start a run.
            </p>
          </div>
          <Button
            loading={discover.isPending}
            onClick={() => discover.mutate()}
            type="button"
            variant="outline"
          >
            <RefreshCw /> Fetch models
          </Button>
        </div>
        {discover.error && (
          <p className="mb-4 text-destructive text-sm" role="alert">
            {discover.error.message}
          </p>
        )}
        {discovered && (
          <div className="mb-4 border p-3">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm">
              <span>
                {discovered.length
                  ? `${discovered.length} new models found`
                  : "No new models found"}
              </span>
              {discovered.length > 0 && (
                <Button
                  disabled={selected.length === 0}
                  loading={addModels.isPending}
                  onClick={() => addModels.mutate()}
                  size="sm"
                  type="button"
                >
                  Add selected ({selected.length})
                </Button>
              )}
            </div>
            <CheckboxGroup
              aria-label="Models to add"
              className="grid gap-2 sm:grid-cols-2"
              onValueChange={setSelected}
              value={selected}
            >
              {discovered.map((modelId) => (
                <Label key={modelId}>
                  <Checkbox value={modelId} />
                  <span className="font-mono text-xs">{modelId}</span>
                </Label>
              ))}
            </CheckboxGroup>
          </div>
        )}
        <div className="divide-y border">
          {provider.models.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground text-sm">
              No models configured.
            </p>
          ) : (
            provider.models.map((model) => (
              <div className="flex items-center gap-3 px-4 py-3" key={model.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{model.label}</p>
                  <p className="truncate font-mono text-muted-foreground text-xs">
                    {model.modelId}
                  </p>
                </div>
                <Button
                  aria-label={`Set ${model.label} as default`}
                  onClick={() => setDefault.mutate(model.id)}
                  size="icon"
                  title="Set as default"
                  type="button"
                  variant={
                    settings.defaultModelId === model.id ? "secondary" : "ghost"
                  }
                >
                  <Star
                    className={
                      settings.defaultModelId === model.id
                        ? "fill-current"
                        : undefined
                    }
                  />
                </Button>
                <Switch
                  aria-label={
                    model.enabled
                      ? `Disable ${model.label}`
                      : `Enable ${model.label}`
                  }
                  checked={model.enabled}
                  onCheckedChange={(enabled) =>
                    modelMutation.mutate({
                      modelId: model.id,
                      body: { enabled: enabled === true },
                    })
                  }
                />
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function RuntimeDefaults({
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
    <section>
      <h2 className="font-semibold text-base">Runtime defaults</h2>
      <p className="mt-1 text-muted-foreground text-sm">
        Used for every new run.
      </p>
      <form
        className="mt-6 grid gap-5 sm:grid-cols-2"
        key={settings.updatedAt}
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          mutation.mutate({
            defaultModelId: String(data.get("defaultModelId")) || null,
            environment: String(data.get("environment")) as
              | "local"
              | "container",
            containerImage: String(data.get("containerImage")).trim(),
            cpus: Number(data.get("cpus")),
            memoryMb: Number(data.get("memoryMb")),
            pidsLimit: Number(data.get("pidsLimit")),
            maxConcurrency: Number(data.get("maxConcurrency")),
          })
        }}
      >
        <Field className="sm:col-span-2" name="defaultModelId">
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
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button loading={mutation.isPending} type="submit">
            Save defaults
          </Button>
          {mutation.error && (
            <p className="text-destructive text-sm" role="alert">
              {mutation.error.message}
            </p>
          )}
        </div>
      </form>
    </section>
  )
}

export function SettingsScreen() {
  const queryClient = useQueryClient()
  const [section, setSection] = useState<"models" | "runtime">("models")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiRequest<{ items: ProviderConnection[] }>("/providers"),
  })
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiRequest<SettingsPublic>("/settings"),
  })
  useEffect(() => {
    if (selectedId || !providers.data?.items.length) return
    setSelectedId(providers.data.items[0].id)
  }, [providers.data, selectedId])
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedId(null)
      queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })

  if (providers.isPending || settings.isPending) {
    return (
      <p className="py-16 text-center text-muted-foreground text-sm">
        Loading settings...
      </p>
    )
  }
  if (providers.error || settings.error) {
    return (
      <p className="py-12 text-destructive text-sm" role="alert">
        {(providers.error ?? settings.error)?.message}
      </p>
    )
  }
  const items = providers.data?.items ?? []
  const selected = items.find((provider) => provider.id === selectedId)
  return (
    <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <aside className="h-min border">
        <div className="border-b px-4 py-3">
          <h2 className="font-semibold text-sm">Settings</h2>
        </div>
        <nav className="space-y-1 p-2" aria-label="Settings sections">
          <Button
            className="w-full justify-start"
            onClick={() => setSection("models")}
            size="sm"
            type="button"
            variant={section === "models" ? "secondary" : "ghost"}
          >
            <Boxes /> Model providers
          </Button>
          <Button
            className="w-full justify-start"
            onClick={() => setSection("runtime")}
            size="sm"
            type="button"
            variant={section === "runtime" ? "secondary" : "ghost"}
          >
            <Settings2 /> Runtime defaults
          </Button>
        </nav>
      </aside>
      {section === "runtime" ? (
        <div className="min-w-0 border p-5 sm:p-6">
          <RuntimeDefaults
            providers={items}
            settings={settings.data as SettingsPublic}
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="h-min border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="font-semibold text-sm">Providers</h2>
                <p className="text-muted-foreground text-xs">
                  {items.length} configured
                </p>
              </div>
              <ProviderDialog
                onCreated={(id) => {
                  setSelectedId(id)
                  queryClient.invalidateQueries({ queryKey: ["providers"] })
                }}
              />
            </div>
            <nav className="p-2" aria-label="Provider connections">
              {items.map((provider) => (
                <div className="mb-1 flex items-center" key={provider.id}>
                  <Button
                    className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left"
                    onClick={() => setSelectedId(provider.id)}
                    type="button"
                    variant={selectedId === provider.id ? "secondary" : "ghost"}
                  >
                    <span className="block truncate font-medium text-sm">
                      {provider.label}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {provider.models.length} models
                      {provider.apiKey ? "" : " · No key"}
                    </span>
                  </Button>
                  <Switch
                    aria-label={
                      provider.enabled
                        ? `Disable ${provider.label}`
                        : `Enable ${provider.label}`
                    }
                    checked={provider.enabled}
                    className="mr-3"
                    onCheckedChange={(enabled) =>
                      apiRequest<ProviderConnection>(
                        `/providers/${provider.id}`,
                        jsonRequest("PATCH", { enabled: enabled === true })
                      ).then(() =>
                        queryClient.invalidateQueries({
                          queryKey: ["providers"],
                        })
                      )
                    }
                  />
                </div>
              ))}
            </nav>
          </aside>
          <div className="min-w-0 border p-5 sm:p-6">
            {selected ? (
              <ProviderDetail
                key={selected.id}
                onDelete={() => remove.mutate(selected.id)}
                provider={selected}
                settings={settings.data as SettingsPublic}
              />
            ) : (
              <p className="py-16 text-center text-muted-foreground text-sm">
                Select a provider to configure it.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
