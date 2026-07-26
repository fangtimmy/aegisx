import { CircleAlert, Link2, Unlink } from "lucide-react"
import { Controller, type useForm } from "react-hook-form"
import type { PiModelProfile, ProviderModel } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import type { ProviderEditor } from "./use-provider-editor"

type EditForm = {
  label: string
  metadata: string
}

export function EditModelDialog({
  editor,
  editForm,
}: {
  editor: ProviderEditor
  editForm: ReturnType<typeof useForm<EditForm>>
}) {
  const {
    editModel,
    editingBinding,
    editingModel,
    metadataError,
    setBindingModel,
    setEditingBinding,
    setEditingModel,
    setMetadataError,
    setSelectedBuiltinModel,
  } = editor

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setEditingModel(null)
          editForm.reset({ label: "", metadata: "{}" })
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
          onSubmit={editForm.handleSubmit((values) => {
            if (!editingModel) return
            let metadata: ProviderModel["metadata"]
            try {
              const parsed = JSON.parse(values.metadata) as unknown
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
              label: values.label.trim(),
              metadata,
              binding: editingBinding,
            })
          })}
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
              <Controller
                control={editForm.control}
                name="label"
                render={({ field }) => (
                  <Input
                    autoFocus
                    id="editing-provider-model-label"
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    required
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
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
              <Controller
                control={editForm.control}
                name="metadata"
                render={({ field }) => (
                  <Textarea
                    className="font-mono text-xs"
                    disabled={Boolean(editingBinding)}
                    id="editing-provider-model-metadata"
                    onChange={(event) => {
                      field.onChange(event.target.value)
                      setMetadataError(null)
                    }}
                    rows={14}
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
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
  )
}

export function BindPiModelDialog({ editor }: { editor: ProviderEditor }) {
  const {
    bindingModel,
    builtinProfiles,
    builtinSearch,
    builtins,
    selectedBuiltinModel,
    selectedProfile,
    setBindingModel,
    setBuiltinSearch,
    setEditingBinding,
    setSelectedBuiltinModel,
  } = editor

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setBindingModel(null)
          setSelectedBuiltinModel(null)
          setBuiltinSearch("")
        }
      }}
      open={bindingModel !== null}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bind Pi built-in model</DialogTitle>
          <DialogDescription>
            Apply a Pi profile to <code>{bindingModel?.modelId}</code>. This
            replaces its metadata but keeps its configured model ID. Any
            built-in profile can be bound regardless of protocol.
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
            <Field>
              <FieldLabel htmlFor="pi-model-binding">Pi model</FieldLabel>
              <Combobox<PiModelProfile>
                filter={(item, query) => {
                  const q = query.trim().toLowerCase()
                  if (!q) return true
                  return (
                    item.name.toLowerCase().includes(q) ||
                    item.modelId.toLowerCase().includes(q) ||
                    item.providerId.toLowerCase().includes(q)
                  )
                }}
                inputValue={builtinSearch}
                isItemEqualToValue={(item, value) =>
                  item.providerId === value.providerId &&
                  item.modelId === value.modelId
                }
                itemToStringLabel={(model) =>
                  `${model.name} (${model.providerId}/${model.modelId})`
                }
                itemToStringValue={(model) =>
                  `${model.providerId}/${model.modelId}`
                }
                items={builtinProfiles}
                onInputValueChange={setBuiltinSearch}
                onValueChange={setSelectedBuiltinModel}
                value={selectedBuiltinModel}
              >
                <ComboboxInput
                  id="pi-model-binding"
                  placeholder="Search by model id, name, or provider"
                />
                <ComboboxPopup>
                  <ComboboxList>
                    <ComboboxCollection>
                      {(model: PiModelProfile) => (
                        <ComboboxItem
                          key={`${model.providerId}/${model.modelId}`}
                          value={model}
                        >
                          <span className="block truncate">{model.name}</span>
                          <span className="block truncate font-mono text-muted-foreground text-xs">
                            {model.providerId}/{model.modelId}
                          </span>
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                    <ComboboxEmpty>No models found</ComboboxEmpty>
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </Field>
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
  )
}

export function DiscoverModelsDialog({ editor }: { editor: ProviderEditor }) {
  const { addModels, discovered, selected, setDiscovered, setSelected } = editor
  const items = discovered ?? []
  const allSelected = items.length > 0 && selected.length === items.length

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setDiscovered(null)
          setSelected([])
        }
      }}
      open={discovered !== null}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add fetched models</DialogTitle>
          <DialogDescription>
            Select the new models to add to this provider.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {items.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-muted-foreground text-xs">
                  {selected.length} of {items.length} selected
                </span>
                <Button
                  disabled={addModels.isPending}
                  onClick={() => setSelected(allSelected ? [] : [...items])}
                  type="button"
                  variant="ghost"
                >
                  {allSelected ? "Clear all" : "Select all"}
                </Button>
              </div>
              <CheckboxGroup
                aria-label="Models to add"
                className="max-h-80 w-full gap-0 overflow-y-auto border-y"
                disabled={addModels.isPending}
                onValueChange={setSelected}
                value={selected}
              >
                {items.map((id) => (
                  <Label
                    className="flex w-full min-w-0 items-center gap-2 px-2 py-2 last:border-b-0"
                    key={id}
                  >
                    <Checkbox value={id} />
                    <span className="min-w-0 flex-1 break-all font-mono text-xs">
                      {id}
                    </span>
                  </Label>
                ))}
              </CheckboxGroup>
            </>
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
            {items.length > 0 ? "Cancel" : "Close"}
          </DialogClose>
          {items.length > 0 && (
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
  )
}
