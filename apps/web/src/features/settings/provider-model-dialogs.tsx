import { isRecord } from "@aegisx/shared"
import { Brain, CircleAlert, Download, Image, Type } from "lucide-react"
import { Controller } from "react-hook-form"

import type { PiModelProfile, ProviderModel } from "@/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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

import {
  formatContext,
  formatPrice,
  formatPriceCompact,
  supportedLevelsOf,
} from "./provider-model-format"
import type { ProviderEditor } from "./use-provider-editor"

/** Compact one-line metadata facts (context / reasoning / vision / price) —
 * shown in catalog list items so same-id models across pi providers can be
 * told apart before importing. Mirrors the badge language of the model list. */
function ProfileBadges({ metadata }: { metadata: ProviderModel["metadata"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge size="sm" variant="secondary">
        {formatContext(metadata.contextWindow)}
      </Badge>
      {metadata.reasoning && (
        <Badge size="sm" variant="secondary">
          <Brain aria-hidden="true" />
        </Badge>
      )}
      <Badge size="sm" variant="secondary">
        {metadata.input.map((input) =>
          input === "image" ? (
            <Image aria-hidden="true" className="mx-px" key={input} />
          ) : (
            <Type aria-hidden="true" className="mx-px" key={input} />
          )
        )}
      </Badge>
      {metadata.costKnown && (
        <Badge size="sm" variant="secondary">
          {formatPriceCompact(metadata)}
        </Badge>
      )}
    </div>
  )
}

/** Rendered view of a metadata JSON — shared by the edit dialog (live-parsed
 * from the textarea, so edits preview before saving) and the import dialog
 * (the profile about to be copied), making a wrong pick visible before it
 * happens. */
function MetadataPreview({
  metadata,
}: {
  metadata: ProviderModel["metadata"]
}) {
  const tiers = metadata.cost.tiers ?? []
  return (
    <div className="rounded-lg border p-3">
      <ProfileBadges metadata={metadata} />
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">上下文窗口</dt>
        <dd>{formatContext(metadata.contextWindow)}</dd>
        <dt className="text-muted-foreground">最大输出</dt>
        <dd>{formatContext(metadata.maxTokens)}</dd>
        <dt className="text-muted-foreground">输入模态</dt>
        <dd>{metadata.input.join("、")}</dd>
        <dt className="text-muted-foreground">推理档位</dt>
        <dd>{supportedLevelsOf(metadata).join(" / ")}</dd>
        {metadata.costKnown ? (
          <>
            <dt className="text-muted-foreground">输入 / 输出</dt>
            <dd>
              {formatPrice(metadata)}（每百万 tokens
              {tiers.length > 0 && `，另有 ${tiers.length} 档分级计价`}）
            </dd>
            <dt className="text-muted-foreground">缓存读 / 写</dt>
            <dd>
              ${metadata.cost.cacheRead} / ${metadata.cost.cacheWrite}（每百万
              tokens）
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">价格</dt>
            <dd>未知</dd>
          </>
        )}
      </dl>
    </div>
  )
}

/** Parse the edit form's metadata textarea into a previewable metadata
 * object, defaulting omitted fields (mirrors the server's normalize closely
 * enough for preview). Null = not a JSON object. */
function parseDraftMetadata(value: string): ProviderModel["metadata"] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const draft = parsed as Partial<ProviderModel["metadata"]>
  return {
    reasoning: draft.reasoning ?? false,
    thinkingLevelMap: draft.thinkingLevelMap ?? {},
    input: draft.input?.length ? draft.input : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...draft.cost },
    costKnown: draft.costKnown ?? false,
    contextWindow: draft.contextWindow ?? 0,
    maxTokens: draft.maxTokens ?? 0,
  }
}

export function EditModelDialog({ editor }: { editor: ProviderEditor }) {
  const {
    editForm,
    editModel,
    editingModel,
    metadataError,
    setEditingModel,
    setImportModel,
    setMetadataError,
  } = editor
  const draft = parseDraftMetadata(editForm.watch("metadata"))

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
      <DialogPopup className="sm:max-w-xl">
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
              const parsed: unknown = JSON.parse(values.metadata)
              if (!isRecord(parsed)) {
                throw new Error()
              }
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 粘贴的自由 JSON 只在客户端校验对象性；字段级校验由服务端 PATCH 兜底。
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
                    // Dialog-managed focus: the input is the dialog's
                    // purpose, autoFocus is intentional.
                    // oxlint-disable-next-line jsx-a11y/no-autofocus
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
            {draft ? (
              <MetadataPreview metadata={draft} />
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                元数据 JSON 无效（不是 JSON 对象）时无法预览。
              </p>
            )}
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
                    rows={10}
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
      <DialogPopup className="sm:max-w-xl">
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
                          <div className="mt-1">
                            <ProfileBadges metadata={model.metadata} />
                          </div>
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                    <ComboboxEmpty>未找到模型</ComboboxEmpty>
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </Field>
          )}
          {builtins.data &&
            (selectedProfile ? (
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {selectedProfile.name}
                  </span>
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {selectedProfile.providerId}/{selectedProfile.modelId}
                  </span>
                </div>
                <div className="mt-2">
                  <MetadataPreview metadata={selectedProfile.metadata} />
                </div>
                <pre className="mt-2 max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs text-muted-foreground">
                  {JSON.stringify(selectedProfile.metadata, null, 2)}
                </pre>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                选择模型后将在此预览其完整元数据。
              </p>
            ))}
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
