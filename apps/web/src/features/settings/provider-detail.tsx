import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Brain,
  CircleAlert,
  DollarSign,
  Eye,
  EyeOff,
  Image,
  Link2,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Type,
  Unlink,
} from "lucide-react"
import { useState } from "react"
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
  CardFooter,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { CheckboxGroup } from "@/components/ui/checkbox-group"
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/components/ui/combobox"
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  apiRequest,
  jsonRequest,
  type PiModelProfile,
  type ProviderConnection,
  type ProviderModel,
} from "@/lib/api"
import { type ProviderInput, providerTypeLabels } from "./provider-config"
import { ProviderTypeField } from "./provider-dialog"

type ProviderUpdate = Omit<ProviderInput, "apiKey"> & { apiKey?: string }

function formatContext(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(value / 1_000)}K`
}

function formatPrice(metadata: ProviderModel["metadata"]) {
  return `$${metadata.cost.input}/M $${metadata.cost.output}/M`
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
  const queryClient = useQueryClient()
  const [label, setLabel] = useState(provider.label)
  const [type, setType] = useState(provider.type)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState(provider.apiKey)
  const [showKey, setShowKey] = useState(false)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [modelId, setModelId] = useState("")
  const [modelLabel, setModelLabel] = useState("")
  const [editingModel, setEditingModel] = useState<ProviderModel | null>(null)
  const [editingLabel, setEditingLabel] = useState("")
  const [editingMetadata, setEditingMetadata] = useState("{}")
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [editingBinding, setEditingBinding] =
    useState<ProviderModel["piBinding"]>(null)
  const [bindingModel, setBindingModel] = useState<ProviderModel | null>(null)
  const [selectedBuiltinProvider, setSelectedBuiltinProvider] = useState("")
  const [selectedBuiltinModel, setSelectedBuiltinModel] =
    useState<PiModelProfile | null>(null)
  const save = useMutation({
    mutationFn: (input: ProviderUpdate) =>
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
    mutationFn: (models: Array<{ modelId: string; label: string }>) =>
      Promise.all(
        models.map((model) =>
          apiRequest<ProviderModel>(
            `/providers/${provider.id}/models`,
            jsonRequest("POST", model)
          )
        )
      ),
    onSuccess: () => {
      setDiscovered(null)
      setSelected([])
      setAddOpen(false)
      setModelId("")
      setModelLabel("")
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
  const editModel = useMutation({
    mutationFn: ({
      id,
      label,
      metadata,
      binding,
    }: {
      id: string
      label: string
      metadata: ProviderModel["metadata"]
      binding: ProviderModel["piBinding"]
    }) =>
      apiRequest<ProviderModel>(
        `/provider-models/${id}`,
        jsonRequest("PATCH", { label, metadata, binding })
      ),
    onSuccess: () => {
      setEditingModel(null)
      setEditingLabel("")
      setEditingMetadata("{}")
      queryClient.invalidateQueries({ queryKey: ["providers"] })
    },
  })
  const builtins = useQuery({
    enabled: Boolean(bindingModel),
    queryKey: ["providers", provider.id, "builtins"],
    queryFn: () =>
      apiRequest<{ items: PiModelProfile[] }>(
        `/providers/${provider.id}/models/builtins`
      ),
  })
  const removeModel = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`/provider-models/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] })
      queryClient.invalidateQueries({ queryKey: ["settings"] })
    },
  })
  const builtinProfiles = builtins.data?.items ?? []
  const builtinProviderIds = [
    ...new Set(builtinProfiles.map((model) => model.providerId)),
  ]
  const filteredBuiltinModels = builtinProfiles.filter(
    (model) => model.providerId === selectedBuiltinProvider
  )
  const selectedProfile = selectedBuiltinModel

  return (
    <div className="flex flex-col gap-4">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>Provider configuration</CardFrameTitle>
          <CardFrameDescription>
            {providerTypeLabels[provider.type]}
          </CardFrameDescription>
          <CardFrameAction>
            <Switch
              aria-label={
                provider.enabled ? "Disable provider" : "Enable provider"
              }
              checked={provider.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) =>
                save.mutate({
                  label,
                  type,
                  baseUrl,
                  apiKey: apiKey.trim() || undefined,
                  enabled: enabled === true,
                })
              }
            />
          </CardFrameAction>
        </CardFrameHeader>
        <Card
          render={
            <form
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate({
                  label: label.trim(),
                  type,
                  baseUrl: baseUrl.trim(),
                  apiKey: apiKey.trim() || undefined,
                  enabled: provider.enabled,
                })
              }}
            />
          }
        >
          <CardPanel className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="selected-provider-name">Name</FieldLabel>
              <Input
                id="selected-provider-name"
                onChange={(event) => setLabel(event.target.value)}
                required
                type="text"
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
              <FieldLabel htmlFor="selected-provider-api-key">
                API key
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  autoComplete="off"
                  id="selected-provider-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  type={showKey ? "text" : "password"}
                  placeholder="Leave blank to keep the current key"
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
          </CardPanel>
          <CardFooter className="flex-wrap gap-2">
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
                    disabled={deletePending}
                    loading={deletePending}
                    onClick={onDelete}
                    type="button"
                    variant="destructive"
                  >
                    Delete provider
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </CardFooter>
        </Card>
      </CardFrame>

      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>
            <span className="flex items-center gap-2">
              Models
              <Badge variant="secondary">{provider.models.length}</Badge>
            </span>
          </CardFrameTitle>
          <CardFrameAction className="flex gap-2">
            <Button
              loading={discover.isPending}
              onClick={() => {
                addModels.reset()
                discover.mutate()
              }}
              type="button"
              variant="outline"
            >
              <RefreshCw /> Fetch models
            </Button>
            <Dialog
              onOpenChange={(open) => {
                setAddOpen(open)
                if (open) addModels.reset()
              }}
              open={addOpen}
            >
              <DialogTrigger render={<Button type="button" />}>
                <Plus /> Add model
              </DialogTrigger>
              <DialogPopup className="sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle>Add model</DialogTitle>
                  <DialogDescription>
                    Enter the model identifier accepted by this provider.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="contents"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const id = modelId.trim()
                    addModels.mutate([
                      { modelId: id, label: modelLabel.trim() || id },
                    ])
                  }}
                >
                  <DialogPanel className="grid gap-4">
                    <Field>
                      <FieldLabel htmlFor="provider-model-id">
                        Model ID
                      </FieldLabel>
                      <Input
                        autoFocus
                        id="provider-model-id"
                        onChange={(event) => setModelId(event.target.value)}
                        required
                        value={modelId}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="provider-model-label">
                        Display name
                      </FieldLabel>
                      <Input
                        id="provider-model-label"
                        onChange={(event) => setModelLabel(event.target.value)}
                        placeholder="Defaults to the model ID"
                        value={modelLabel}
                      />
                    </Field>
                    {addModels.error && (
                      <Alert variant="error">
                        <CircleAlert />
                        <AlertDescription>
                          {addModels.error.message}
                        </AlertDescription>
                      </Alert>
                    )}
                  </DialogPanel>
                  <DialogFooter>
                    <DialogClose
                      render={<Button type="button" variant="ghost" />}
                    >
                      Cancel
                    </DialogClose>
                    <Button loading={addModels.isPending} type="submit">
                      Add model
                    </Button>
                  </DialogFooter>
                </form>
              </DialogPopup>
            </Dialog>
          </CardFrameAction>
        </CardFrameHeader>
        <Card>
          <CardPanel className="flex flex-col gap-4">
            {discover.error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{discover.error.message}</AlertDescription>
              </Alert>
            )}
            {(modelMutation.error || removeModel.error) && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>
                  {(modelMutation.error ?? removeModel.error)?.message}
                </AlertDescription>
              </Alert>
            )}
            <div className="divide-y">
              {provider.models.length === 0 ? (
                <Empty className="py-10">
                  <EmptyHeader>
                    <EmptyTitle>No models configured</EmptyTitle>
                    <EmptyDescription>
                      Add a model manually or fetch models from this provider.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                provider.models.map((model) => (
                  <div className="flex items-center gap-3 py-3" key={model.id}>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-medium text-sm">
                          {model.label}
                        </span>
                        <Badge
                          variant="secondary"
                        >
                          {model.modelId}
                        </Badge>
                        {model.piBinding && (
                          <Badge variant="secondary">
                            <Link2 />
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Badge size="sm" variant="secondary">
                          {formatContext(model.metadata.contextWindow)}
                        </Badge>
                        {model.metadata.reasoning && (
                          <Badge size="sm" variant="secondary">
                            <Brain aria-hidden="true" />
                          </Badge>
                        )}
                        <Badge size="sm" variant="secondary">
                          {model.metadata.input.map((input) => (
                            <span
                              className="inline-flex items-center gap-1"
                              key={input}
                            >
                              {input === "image" ? (
                                <Image aria-hidden="true" />
                              ) : (
                                <Type aria-hidden="true" />
                              )}
                            </span>
                          ))}
                        </Badge>
                        {model.metadata.costKnown && (
                          <Badge size="sm" variant="secondary">
                            {formatPrice(model.metadata)}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      aria-label={`Edit ${model.label}`}
                      onClick={() => {
                        editModel.reset()
                        setEditingModel(model)
                        setEditingLabel(model.label)
                        setEditingMetadata(
                          JSON.stringify(model.metadata, null, 2)
                        )
                        setEditingBinding(model.piBinding)
                        setMetadataError(null)
                      }}
                      size="icon"
                      title="Edit model"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            aria-label={`Delete ${model.label}`}
                            size="icon"
                            title="Delete model"
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
                            Delete {model.label}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This model will no longer be available for new runs.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose
                            render={<Button type="button" variant="ghost" />}
                          >
                            Cancel
                          </AlertDialogClose>
                          <Button
                            loading={
                              removeModel.isPending &&
                              removeModel.variables === model.id
                            }
                            onClick={() => removeModel.mutate(model.id)}
                            type="button"
                            variant="destructive"
                          >
                            Delete model
                          </Button>
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
                    <Switch
                      aria-label={
                        model.enabled
                          ? `Disable ${model.label}`
                          : `Enable ${model.label}`
                      }
                      checked={model.enabled}
                      disabled={modelMutation.isPending}
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
          </CardPanel>
        </Card>
      </CardFrame>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setEditingModel(null)
            setEditingLabel("")
            setEditingMetadata("{}")
            setMetadataError(null)
            setEditingBinding(null)
          }
        }}
        open={editingModel !== null}
      >
        <DialogPopup className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit model</DialogTitle>
            <DialogDescription>
              Model IDs cannot be changed after they are added.
            </DialogDescription>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              if (editingModel) {
                let metadata: ProviderModel["metadata"]
                try {
                  const parsed = JSON.parse(editingMetadata) as unknown
                  if (
                    !parsed ||
                    typeof parsed !== "object" ||
                    Array.isArray(parsed)
                  ) {
                    throw new Error()
                  }
                  metadata = parsed as ProviderModel["metadata"]
                } catch {
                  setMetadataError("Enter a JSON object")
                  return
                }
                editModel.mutate({
                  id: editingModel.id,
                  label: editingLabel.trim(),
                  metadata,
                  binding: editingBinding,
                })
              }
            }}
          >
            <DialogPanel className="grid gap-4">
              <Field>
                <FieldLabel htmlFor="editing-provider-model-id">
                  Model ID
                </FieldLabel>
                <Input
                  disabled
                  id="editing-provider-model-id"
                  value={editingModel?.modelId ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="editing-provider-model-label">
                  Display name
                </FieldLabel>
                <Input
                  autoFocus
                  id="editing-provider-model-label"
                  onChange={(event) => setEditingLabel(event.target.value)}
                  required
                  value={editingLabel}
                />
              </Field>
              <Field>
                <div className="flex w-full min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <FieldLabel htmlFor="editing-provider-model-metadata">
                      Metadata JSON
                    </FieldLabel>
                    {editingBinding && (
                      <p className="truncate font-mono text-muted-foreground text-xs">
                        Bound to {editingBinding.providerId} /{" "}
                        {editingBinding.modelId}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      onClick={() => {
                        setBindingModel(editingModel ?? null)
                        setSelectedBuiltinProvider("")
                        setSelectedBuiltinModel(null)
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Link2 /> {editingBinding ? "Change" : "Bind"}
                    </Button>
                    {editingBinding && (
                      <Button
                        aria-label="Unbind Pi model"
                        onClick={() => setEditingBinding(null)}
                        size="icon-sm"
                        title="Unbind Pi model"
                        type="button"
                        variant="outline"
                      >
                        <Unlink />
                      </Button>
                    )}
                  </div>
                </div>
                <Textarea
                  className="font-mono text-xs"
                  disabled={Boolean(editingBinding)}
                  id="editing-provider-model-metadata"
                  onChange={(event) => {
                    setEditingMetadata(event.target.value)
                    setMetadataError(null)
                  }}
                  rows={14}
                  value={editingMetadata}
                />
              </Field>
              {metadataError && (
                <Alert variant="error">
                  <CircleAlert />
                  <AlertDescription>{metadataError}</AlertDescription>
                </Alert>
              )}
              {editModel.error && (
                <Alert variant="error">
                  <CircleAlert />
                  <AlertDescription>{editModel.error.message}</AlertDescription>
                </Alert>
              )}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>
                Cancel
              </DialogClose>
              <Button loading={editModel.isPending} type="submit">
                Save model
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setBindingModel(null)
            setSelectedBuiltinProvider("")
            setSelectedBuiltinModel(null)
          }
        }}
        open={bindingModel !== null}
      >
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Bind Pi built-in model</DialogTitle>
            <DialogDescription>
              Apply a Pi profile to <code>{bindingModel?.modelId}</code>. This
              replaces its metadata but keeps its configured model ID.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            {builtins.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner aria-hidden="true" /> Loading Pi models...
              </div>
            ) : builtins.error ? (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{builtins.error.message}</AlertDescription>
              </Alert>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="pi-provider-binding">
                    Pi provider
                  </FieldLabel>
                  <Combobox<string>
                    items={builtinProviderIds}
                    onValueChange={(value) => {
                      setSelectedBuiltinProvider(value ?? "")
                      setSelectedBuiltinModel(null)
                    }}
                    value={selectedBuiltinProvider || null}
                  >
                    <ComboboxInput
                      id="pi-provider-binding"
                      placeholder="Search Pi providers"
                    />
                    <ComboboxPopup>
                      <ComboboxList>
                        <ComboboxCollection>
                          {(providerId) => (
                            <ComboboxItem key={providerId} value={providerId}>
                              {providerId}
                            </ComboboxItem>
                          )}
                        </ComboboxCollection>
                        <ComboboxEmpty>No providers found</ComboboxEmpty>
                      </ComboboxList>
                    </ComboboxPopup>
                  </Combobox>
                </Field>
                <Field>
                  <FieldLabel htmlFor="pi-model-binding">Pi model</FieldLabel>
                  <Combobox<PiModelProfile>
                    disabled={!selectedBuiltinProvider}
                    itemToStringLabel={(model) => model.name}
                    itemToStringValue={(model) => model.modelId}
                    items={filteredBuiltinModels}
                    onValueChange={setSelectedBuiltinModel}
                    value={selectedBuiltinModel}
                  >
                    <ComboboxInput
                      id="pi-model-binding"
                      placeholder="Search Pi models"
                    />
                    <ComboboxPopup>
                      <ComboboxList>
                        <ComboboxCollection>
                          {(model: PiModelProfile) => (
                            <ComboboxItem key={model.modelId} value={model}>
                              <span className="block truncate">
                                {model.name}
                              </span>
                              <span className="block truncate font-mono text-muted-foreground text-xs">
                                {model.modelId}
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxCollection>
                        <ComboboxEmpty>No models found</ComboboxEmpty>
                      </ComboboxList>
                    </ComboboxPopup>
                  </Combobox>
                </Field>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={!bindingModel || !selectedProfile}
              onClick={() => {
                if (bindingModel && selectedProfile) {
                  setEditingBinding({
                    providerId: selectedProfile.providerId,
                    modelId: selectedProfile.modelId,
                  })
                  setBindingModel(null)
                }
              }}
              type="button"
            >
              <Link2 /> Bind model
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setDiscovered(null)
            setSelected([])
          }
        }}
        open={discovered !== null}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add fetched models</DialogTitle>
            <DialogDescription>
              Select the new models to add to this provider.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {discovered?.length ? (
              <CheckboxGroup
                aria-label="Models to add"
                className="grid grid-cols-2 gap-2"
                onValueChange={setSelected}
                value={selected}
              >
                {discovered.map((id) => (
                  <Label className="min-w-0" key={id}>
                    <Checkbox value={id} />
                    <span className="min-w-0 break-all font-mono text-xs">
                      {id}
                    </span>
                  </Label>
                ))}
              </CheckboxGroup>
            ) : (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyTitle>No new models found</EmptyTitle>
                  <EmptyDescription>
                    All fetched models are already configured.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {addModels.error && (
              <Alert className="mt-4" variant="error">
                <CircleAlert />
                <AlertDescription>{addModels.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              {discovered?.length ? "Cancel" : "Close"}
            </DialogClose>
            {Boolean(discovered?.length) && (
              <Button
                disabled={selected.length === 0}
                loading={addModels.isPending}
                onClick={() =>
                  addModels.mutate(
                    selected.map((id) => ({ modelId: id, label: id }))
                  )
                }
                type="button"
              >
                Add selected ({selected.length})
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
