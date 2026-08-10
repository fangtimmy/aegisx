import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Download,
  FileArchive,
  Flag,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { useRef, useState } from "react"
import { Controller, useForm } from "react-hook-form"

import {
  type Attachment,
  type Challenge,
  type ChallengeFlag,
  challengesApi,
  eventsApi,
  keys,
} from "@/api"
import { IconTooltip } from "@/components/shell/product-header"
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
import { Button } from "@/components/ui/button"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function pendingFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function mergePendingFiles(current: File[], incoming: File[]) {
  const seen = new Set(current.map(pendingFileKey))
  const next = [...current]
  for (const file of incoming) {
    if (file.size <= 0) continue
    const key = pendingFileKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(file)
  }
  return next
}

type ChallengeMutationResult = {
  challenge: Challenge
  uploadErrors: string[]
}

type ChallengeFormValues = {
  name: string
  description: string
  category: string
  points: number | null
}

type ChallengeDialogProps = {
  eventId: string
  challenge?: Challenge
  onUploadError: (message: string | null) => void
}

export function ChallengeDialog({
  eventId,
  challenge,
  onUploadError,
}: ChallengeDialogProps) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          challenge ? (
            <Button
              aria-label={`查看并编辑 ${challenge.name}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          ) : (
            <Button type="button" />
          )
        }
      >
        {challenge ? (
          <Pencil />
        ) : (
          <>
            <Plus /> 添加题目
          </>
        )}
      </DialogTrigger>
      {open ? (
        <ChallengeDialogContent
          challenge={challenge}
          eventId={eventId}
          onClose={() => setOpen(false)}
          onUploadError={onUploadError}
        />
      ) : null}
    </Dialog>
  )
}

function ChallengeDialogContent({
  eventId,
  challenge,
  onUploadError,
  onClose,
}: ChallengeDialogProps & {
  onClose: () => void
}) {
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const uploadInput = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) =>
      challengesApi.deleteAttachment(attachmentId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
  })
  const removeTarget = useMutation({
    mutationFn: () => challengesApi.ignoreTarget(challenge?.id ?? ""),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
  })
  const form = useForm<ChallengeFormValues>({
    defaultValues: {
      name: challenge?.name ?? "",
      description: challenge?.description ?? "",
      category: challenge?.category ?? "",
      points: challenge?.points ?? null,
    },
  })
  const mutation = useMutation({
    mutationFn: async ({
      values,
      files,
    }: {
      values: ChallengeFormValues
      files: File[]
    }): Promise<ChallengeMutationResult> => {
      const input = {
        name: values.name.trim(),
        description: values.description.trim(),
        category: values.category.trim() || null,
        points: values.points,
      }
      const saved = challenge
        ? await challengesApi.updateChallenge(challenge.id, input)
        : await eventsApi.createChallenge(eventId, input)

      const results = await Promise.allSettled(
        files.map((file) => challengesApi.uploadAttachment(saved.id, file))
      )
      return {
        challenge: saved,
        uploadErrors: results.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                `${files[index].name}：${result.reason instanceof Error ? result.reason.message : "上传失败"}`,
              ]
            : []
        ),
      }
    },
    onSuccess: async ({ challenge: saved, uploadErrors }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.events.detail(eventId),
        }),
        queryClient.invalidateQueries({ queryKey: keys.events.all }),
      ])
      onUploadError(
        uploadErrors.length > 0
          ? `${saved.name} 已保存，但部分附件失败：${uploadErrors.join("；")}`
          : null
      )
      onClose()
    },
  })

  return (
    <DialogPopup className="max-w-2xl overflow-hidden">
      <DialogHeader>
        <DialogTitle>{challenge?.name ?? "创建题目"}</DialogTitle>
        <DialogDescription>
          {challenge
            ? `${challenge.category || "未分类"}${challenge.points === null ? "" : ` · ${challenge.points} 分`}`
            : "填写任务详情并添加其附件。"}
        </DialogDescription>
      </DialogHeader>
      <form
        className="contents"
        onSubmit={form.handleSubmit((values) => {
          const files = pendingFiles.filter((file) => file.size > 0)
          mutation.mutate({ values, files })
        })}
      >
        <DialogPanel className="min-w-0 overflow-x-hidden p-0">
          <section
            aria-labelledby="challenge-details"
            className="grid gap-4 px-6 pb-6"
          >
            <h3 className="text-sm font-medium" id="challenge-details">
              详情
            </h3>
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Controller
                control={form.control}
                name="name"
                render={({ field }) => (
                  <Input
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
              <FieldLabel>描述</FieldLabel>
              <Controller
                control={form.control}
                name="description"
                render={({ field }) => (
                  <Textarea
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    required
                    rows={6}
                    value={field.value}
                  />
                )}
                rules={{ required: true }}
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Field>
                <FieldLabel>分类</FieldLabel>
                <Controller
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <Input
                      onChange={field.onChange}
                      placeholder="Web、Crypto、Pwn…"
                      type="text"
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Field>
                <FieldLabel>分值</FieldLabel>
                <Controller
                  control={form.control}
                  name="points"
                  render={({ field }) => (
                    <NumberField
                      min={0}
                      onValueChange={(value) => field.onChange(value ?? null)}
                      step={1}
                      value={field.value ?? undefined}
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement />
                        <NumberFieldInput />
                        <NumberFieldIncrement />
                      </NumberFieldGroup>
                    </NumberField>
                  )}
                />
              </Field>
            </div>
          </section>
          <section
            aria-labelledby="challenge-attachments"
            className="border-t px-6 py-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium" id="challenge-attachments">
                附件
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {(challenge?.attachments.length ?? 0) + pendingFiles.length}
                </span>
                <Button
                  aria-label="上传附件"
                  onClick={() => uploadInput.current?.click()}
                  size="icon-sm"
                  title="上传附件"
                  type="button"
                  variant="outline"
                >
                  <Upload />
                </Button>
                <input
                  className="sr-only"
                  multiple
                  name="attachments"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? [])
                    setPendingFiles((current) =>
                      mergePendingFiles(current, files)
                    )
                    event.target.value = ""
                  }}
                  ref={uploadInput}
                  tabIndex={-1}
                  type="file"
                />
              </div>
            </div>
            {(challenge?.attachments.length ?? 0) > 0 ||
            pendingFiles.length > 0 ? (
              <div className="mt-3 border-y">
                {challenge?.attachments.map((attachment) => (
                  <AttachmentRow
                    attachment={attachment}
                    deleting={
                      removeAttachment.isPending &&
                      removeAttachment.variables === attachment.id
                    }
                    key={attachment.id}
                    onDelete={() => removeAttachment.mutate(attachment.id)}
                  />
                ))}
                {pendingFiles.map((file) => (
                  <PendingFileRow
                    file={file}
                    key={pendingFileKey(file)}
                    onRemove={() =>
                      setPendingFiles((current) =>
                        current.filter(
                          (item) =>
                            pendingFileKey(item) !== pendingFileKey(file)
                        )
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                暂无附件。上传文件以附加到本题目。
              </p>
            )}
          </section>
          {challenge ? (
            <FlagsSection challenge={challenge} eventId={eventId} />
          ) : null}
          {challenge?.remoteTarget && !challenge.remoteTargetIgnored && (
            <section
              aria-labelledby="challenge-target"
              className="border-t px-6 py-5"
            >
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium" id="challenge-target">
                    平台目标
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    导入的目标无法编辑。移除该目标后，后续任务将停用平台目标工具。
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button type="button" variant="destructive-outline" />
                    }
                  >
                    <Trash2 /> 移除目标
                  </AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>移除平台目标？</AlertDialogTitle>
                      <AlertDialogDescription>
                        需先停止该目标；此后平台同步仍会忽略它。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose
                        render={<Button type="button" variant="ghost" />}
                      >
                        取消
                      </AlertDialogClose>
                      <Button
                        loading={removeTarget.isPending}
                        onClick={() => removeTarget.mutate()}
                        type="button"
                        variant="destructive"
                      >
                        移除目标
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              </div>
              {challenge.targets.length > 0 && (
                <div className="mt-3 border-y">
                  {challenge.targets.map((target) => (
                    <div
                      className="flex min-w-0 items-center justify-between gap-3 border-b py-2 last:border-b-0"
                      key={`${target.name}:${target.services.join(",")}`}
                    >
                      <span className="min-w-0 truncate text-sm">
                        {target.name}
                      </span>
                      <span className="min-w-0 text-right text-xs break-all text-muted-foreground">
                        {target.services.join(", ") || "无暴露服务"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {(removeAttachment.error || removeTarget.error) && (
            <Alert className="mx-6 mb-4 w-auto" variant="error">
              <TriangleAlert />
              <AlertDescription className="wrap-break-word">
                {(removeAttachment.error ?? removeTarget.error)?.message}
              </AlertDescription>
            </Alert>
          )}
          {mutation.error && (
            <Alert className="mx-6 mb-4 w-auto" variant="error">
              <TriangleAlert />
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            取消
          </DialogClose>
          <Button loading={mutation.isPending} type="submit">
            {challenge ? "保存更改" : "创建题目"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  )
}

function AttachmentRow({
  attachment,
  deleting = false,
  onDelete,
}: {
  attachment: Attachment
  deleting?: boolean
  onDelete?: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <FileArchive className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {attachment.originalName}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatBytes(attachment.size)}
        </p>
      </div>
      <IconTooltip label={`下载 ${attachment.originalName}`}>
        <Button
          aria-label={`下载 ${attachment.originalName}`}
          render={<a href={attachment.downloadUrl} />}
          size="icon-sm"
          variant="ghost"
        >
          <Download />
        </Button>
      </IconTooltip>
      {onDelete && (
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                aria-label={`删除 ${attachment.originalName}`}
                size="icon-sm"
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
                删除 {attachment.originalName}？
              </AlertDialogTitle>
              <AlertDialogDescription>
                平台附件会在下次同步该题目时重新下载。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                render={<Button type="button" variant="ghost" />}
              >
                取消
              </AlertDialogClose>
              <Button
                loading={deleting}
                onClick={onDelete}
                type="button"
                variant="destructive"
              >
                删除附件
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  )
}

function PendingFileRow({
  file,
  onRemove,
}: {
  file: File
  onRemove: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <FileArchive className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatBytes(file.size)} · 保存时上传
        </p>
      </div>
      <IconTooltip label={`移除 ${file.name}`}>
        <Button
          aria-label={`移除 ${file.name}`}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </IconTooltip>
    </div>
  )
}

const FLAG_STATUS_LABEL: Record<ChallengeFlag["status"], string> = {
  pending: "待验证",
  accepted: "已验证",
  rejected: "已拒绝",
  error: "错误",
}

/** One-to-many flag management: record manual candidates, remove any flag. */
function FlagsSection({
  challenge,
  eventId,
}: {
  challenge: Challenge
  eventId: string
}) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState("")
  const addFlag = useMutation({
    mutationFn: (flag: string) =>
      challengesApi.addManualFlag(challenge.id, flag),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.events.detail(eventId),
      })
      setValue("")
      toast.success("已记录 flag")
    },
    onError: (error) => toast.error("添加 flag 失败", error.message),
  })
  const deleteFlag = useMutation({
    mutationFn: (flagId: string) =>
      challengesApi.deleteManualFlag(challenge.id, flagId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.events.detail(eventId),
      })
    },
    onError: (error) => toast.error("删除 flag 失败", error.message),
  })
  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    addFlag.mutate(trimmed)
  }
  return (
    <section aria-labelledby="challenge-flags" className="border-t px-6 py-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium" id="challenge-flags">
          Flag
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {challenge.flags.length}
        </span>
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="输入 flag 字符串，回车记录"
          type="text"
          value={value}
        />
        <Button
          disabled={!value.trim()}
          loading={addFlag.isPending}
          onClick={submit}
          type="button"
          variant="outline"
        >
          <Plus /> 记录
        </Button>
      </div>
      {challenge.flags.length > 0 ? (
        <ul className="mt-3 border-y">
          {challenge.flags.map((flag) => (
            <FlagRow
              deleting={
                deleteFlag.isPending && deleteFlag.variables === flag.id
              }
              flag={flag}
              key={flag.id}
              onDelete={() => deleteFlag.mutate(flag.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          暂无 flag。记录的候选 flag 默认视为本地已验证。
        </p>
      )}
    </section>
  )
}

function FlagRow({
  flag,
  deleting = false,
  onDelete,
}: {
  flag: ChallengeFlag
  deleting?: boolean
  onDelete: () => void
}) {
  return (
    <li className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0">
      <Flag className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs break-all">{flag.flag}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {FLAG_STATUS_LABEL[flag.status]}
          {flag.source === "manual"
            ? " · 手动"
            : flag.runId
              ? " · 任务提交"
              : ""}
        </p>
      </div>
      <IconTooltip label="删除 flag">
        <Button
          aria-label="删除 flag"
          loading={deleting}
          onClick={onDelete}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </IconTooltip>
    </li>
  )
}
