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
} from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import type { ProviderConnection, ProviderModel } from "@/api"
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
import { Switch } from "@/components/ui/switch"
import {
  BindPiModelDialog,
  DiscoverModelsDialog,
  EditModelDialog,
} from "./provider-model-dialogs"
import { formatContext, formatPrice } from "./provider-model-format"
import type { ProviderEditor } from "./use-provider-editor"

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
    discover,
    editModel,
    modelMutation,
    removeModel,
    setAddOpen,
    setEditingBinding,
    setEditingModel,
    setMetadataError,
  } = editor
  const addForm = useForm<{ modelId: string; label: string }>({
    defaultValues: { modelId: "", label: "" },
  })
  const editForm = useForm<{
    label: string
    metadata: string
  }>({
    defaultValues: { label: "", metadata: "{}" },
  })
  const openEdit = (model: ProviderModel) => {
    editModel.reset()
    setEditingModel(model)
    editForm.reset({
      label: model.label,
      metadata: JSON.stringify(model.metadata, null, 2),
    })
    setEditingBinding(model.piBinding)
    setMetadataError(null)
  }

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
                  onSubmit={addForm.handleSubmit((values) => {
                    const id = values.modelId.trim()
                    addModels.mutate([
                      { modelId: id, label: values.label.trim() || id },
                    ])
                  })}
                >
                  <DialogPanel className="grid gap-4">
                    <Field>
                      <FieldLabel htmlFor="provider-model-id">
                        Model ID
                      </FieldLabel>
                      <Controller
                        control={addForm.control}
                        name="modelId"
                        render={({ field }) => (
                          <Input
                            autoFocus
                            id="provider-model-id"
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
                      <FieldLabel htmlFor="provider-model-label">
                        Display name
                      </FieldLabel>
                      <Controller
                        control={addForm.control}
                        name="label"
                        render={({ field }) => (
                          <Input
                            id="provider-model-label"
                            onBlur={field.onBlur}
                            onChange={field.onChange}
                            placeholder="Defaults to the model ID"
                            value={field.value}
                          />
                        )}
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
                      onClick={() => openEdit(model)}
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
      <EditModelDialog editForm={editForm} editor={editor} />
      <BindPiModelDialog editor={editor} />
      <DiscoverModelsDialog editor={editor} />
    </>
  )
}
