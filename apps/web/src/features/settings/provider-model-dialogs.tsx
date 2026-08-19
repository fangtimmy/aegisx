import { CircleAlert, Download } from "lucide-react"
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
    editingModel,
    metadataError,
    setEditingModel,
    setImportModel,
    setMetadataError,
  } = editor

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setEditingModel(null)
          editForm.reset({ label: "", metadata: "{}" })
          setMetadataError(null)
        }
      }}
      open={editingModel !== null}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>编辑模型</DialogTitle>
          <DialogDescription>模型 ID 在添加后无法更改。</DialogDescription>
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
              setMetadataError("请输入一个 JSON 对象")
              return
            }
            editModel.mutate({
              id: editingModel.id,
              label: values.label.trim(),
              metadata,
            })
          })}
        >
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="editing-provider-model-id">
                模型 ID
              </FieldLabel>
              <Input
                disabled
                id="editing-provider-model-id"
                value={editingModel?.modelId ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="editing-provider-model-label">
                显示名称
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
                    元数据 JSON
                  </FieldLabel>
                  {editingModel?.metadataSource && (
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      导入自 {editingModel.metadataSource}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    onClick={() => setImportModel(editingModel ?? null)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Download /> 从 Pi 目录导入
                  </Button>
                </div>
              </div>
              <Controller
                control={editForm.control}
                name="metadata"
                render={({ field }) => (
                  <Textarea
                    className="font-mono text-xs"
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
              取消
            </DialogClose>
            <Button loading={editModel.isPending} type="submit">
              保存模型
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function ImportPiModelDialog({ editor }: { editor: ProviderEditor }) {
  const {
    importModel,
    builtinProfiles,
    importSearch,
    builtins,
    selectedBuiltinModel,
    selectedProfile,
    setImportModel,
    setImportSearch,
    setSelectedBuiltinModel,
    importMetadata,
  } = editor

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setImportModel(null)
          setImportSearch("")
        }
      }}
      open={importModel !== null}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Pi 目录导入元数据</DialogTitle>
          <DialogDescription>
            将一个 Pi profile 的元数据拷贝到 <code>{importModel?.modelId}</code>
            。拷贝后仍可自由编辑；重复导入会重新同步。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {builtins.isPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" /> 正在加载 Pi 模型…
            </div>
          ) : builtins.error ? (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>{builtins.error.message}</AlertDescription>
            </Alert>
          ) : (
            <Field>
              <FieldLabel htmlFor="pi-model-import">Pi 模型</FieldLabel>
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
                inputValue={importSearch}
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
                onInputValueChange={setImportSearch}
                onValueChange={setSelectedBuiltinModel}
                value={selectedBuiltinModel}
              >
                <ComboboxInput
                  id="pi-model-import"
                  placeholder="按模型 ID、名称或供应商搜索"
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
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {model.providerId}/{model.modelId}
                          </span>
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                    <ComboboxEmpty>未找到模型</ComboboxEmpty>
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </Field>
          )}
          {importMetadata.error && (
            <Alert variant="error">
              <CircleAlert />
              <AlertDescription>
                {importMetadata.error.message}
              </AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            取消
          </DialogClose>
          <Button
            disabled={!importModel || !selectedProfile}
            loading={importMetadata.isPending}
            onClick={() => {
              if (importModel && selectedProfile) {
                importMetadata.mutate({
                  id: importModel.id,
                  profile: selectedProfile,
                })
              }
            }}
            type="button"
          >
            <Download /> 导入元数据
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
          <DialogTitle>添加已获取的模型</DialogTitle>
          <DialogDescription>选择要添加到该供应商的新模型。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {items.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  已选 {selected.length} / 共 {items.length}
                </span>
                <Button
                  disabled={addModels.isPending}
                  onClick={() => setSelected(allSelected ? [] : [...items])}
                  type="button"
                  variant="ghost"
                >
                  {allSelected ? "清除全部" : "全选"}
                </Button>
              </div>
              <CheckboxGroup
                aria-label="要添加的模型"
                className="max-h-80 w-full gap-0 overflow-y-auto border-y"
                disabled={addModels.isPending}
                onValueChange={setSelected}
                value={selected}
              >
                {items.map((id) => (
                  <Label
                    className="flex w-full min-w-0 items-center gap-2 p-2 last:border-b-0"
                    key={id}
                  >
                    <Checkbox value={id} />
                    <span className="min-w-0 flex-1 font-mono text-xs break-all">
                      {id}
                    </span>
                  </Label>
                ))}
              </CheckboxGroup>
            </>
          ) : (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyTitle>未发现新模型</EmptyTitle>
                <EmptyDescription>所有获取到的模型均已配置。</EmptyDescription>
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
            {items.length > 0 ? "取消" : "关闭"}
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
              添加所选（{selected.length}）
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
