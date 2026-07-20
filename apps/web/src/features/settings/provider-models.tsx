import {
  Brain,
  CircleAlert,
  Image,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Type,
  Unlink,
} from "lucide-react"
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
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type {
  PiModelProfile,
  ProviderConnection,
  ProviderModel,
} from "@/lib/api"
import type { ProviderEditor } from "./use-provider-editor"

function formatContext(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(value / 1_000)}K`
}

function formatPrice(metadata: ProviderModel["metadata"]) {
  return `$${metadata.cost.input}/M $${metadata.cost.output}/M`
}

export function ProviderModels({
  provider,
  editor,
}: {
  provider: ProviderConnection
  editor: ProviderEditor
}) {
  const {
    addModels,
    addOpen,
    bindingModel,
    builtins,
    discover,
    discovered,
    editModel,
    editingBinding,
    editingLabel,
    editingMetadata,
    editingModel,
    filteredBuiltinModels,
    metadataError,
    modelId,
    modelLabel,
    modelMutation,
    removeModel,
    selected,
    selectedBuiltinModel,
    selectedBuiltinProvider,
    selectedProfile,
    setAddOpen,
    setBindingModel,
    setDiscovered,
    setEditingBinding,
    setEditingLabel,
    setEditingMetadata,
    setEditingModel,
    setMetadataError,
    setModelId,
    setModelLabel,
    setSelected,
    setSelectedBuiltinModel,
    setSelectedBuiltinProvider,
  } = editor

  return (
    <>
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
                        <Badge variant="secondary">{model.modelId}</Badge>
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
                    items={editor.builtinProviderIds}
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
    </>
  )
}
