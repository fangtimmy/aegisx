import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Download,
  FileArchive,
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
              aria-label={`View and edit ${challenge.name}`}
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
            <Plus /> Add challenge
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
                `${files[index].name}: ${result.reason instanceof Error ? result.reason.message : "Upload failed"}`,
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
          ? `${saved.name} was saved, but some attachments failed: ${uploadErrors.join("; ")}`
          : null
      )
      onClose()
    },
  })

  return (
    <DialogPopup className="max-w-2xl overflow-hidden">
      <DialogHeader>
        <DialogTitle>{challenge?.name ?? "Create challenge"}</DialogTitle>
        <DialogDescription>
          {challenge
            ? `${challenge.category || "Uncategorized"}${challenge.points === null ? "" : ` · ${challenge.points} pts`}`
            : "Define the task details and add its attachments."}
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
            <h3 className="font-medium text-sm" id="challenge-details">
              Details
            </h3>
            <Field>
              <FieldLabel>Name</FieldLabel>
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
              <FieldLabel>Description</FieldLabel>
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
                <FieldLabel>Category</FieldLabel>
                <Controller
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <Input
                      onChange={field.onChange}
                      placeholder="Web, Crypto, Pwn..."
                      type="text"
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Field>
                <FieldLabel>Points</FieldLabel>
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
              <h3 className="font-medium text-sm" id="challenge-attachments">
                Attachments
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {(challenge?.attachments.length ?? 0) + pendingFiles.length}
                </span>
                <Button
                  aria-label="Upload attachments"
                  onClick={() => uploadInput.current?.click()}
                  size="icon-sm"
                  title="Upload attachments"
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
              <p className="mt-3 text-muted-foreground text-xs">
                No attachments yet. Upload files to include with this challenge.
              </p>
            )}
          </section>
          {challenge?.remoteTarget && !challenge.remoteTargetIgnored && (
            <section
              aria-labelledby="challenge-target"
              className="border-t px-6 py-5"
            >
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="font-medium text-sm" id="challenge-target">
                    Platform target
                  </h3>
                  <p className="mt-1 text-muted-foreground text-xs">
                    Imported targets cannot be edited. Removing this target
                    disables platform target tools for future Runs.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button type="button" variant="destructive-outline" />
                    }
                  >
                    <Trash2 /> Remove target
                  </AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Remove platform target?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        The target must be stopped first. AegisX will keep it
                        ignored after future platform syncs.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose
                        render={<Button type="button" variant="ghost" />}
                      >
                        Cancel
                      </AlertDialogClose>
                      <Button
                        loading={removeTarget.isPending}
                        onClick={() => removeTarget.mutate()}
                        type="button"
                        variant="destructive"
                      >
                        Remove target
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
                      <span className="min-w-0 break-all text-right text-muted-foreground text-xs">
                        {target.services.join(", ") || "No exposed services"}
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
              <AlertDescription className="break-words">
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
            Cancel
          </DialogClose>
          <Button loading={mutation.isPending} type="submit">
            {challenge ? "Save changes" : "Create challenge"}
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
        <p className="truncate font-medium text-sm">
          {attachment.originalName}
        </p>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {formatBytes(attachment.size)}
        </p>
      </div>
      <IconTooltip label={`Download ${attachment.originalName}`}>
        <Button
          aria-label={`Download ${attachment.originalName}`}
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
                aria-label={`Delete ${attachment.originalName}`}
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
                Delete {attachment.originalName}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Platform attachments will return the next time this challenge is
                synchronized.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                render={<Button type="button" variant="ghost" />}
              >
                Cancel
              </AlertDialogClose>
              <Button
                loading={deleting}
                onClick={onDelete}
                type="button"
                variant="destructive"
              >
                Delete attachment
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
        <p className="truncate font-medium text-sm">{file.name}</p>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {formatBytes(file.size)} · uploads on save
        </p>
      </div>
      <IconTooltip label={`Remove ${file.name}`}>
        <Button
          aria-label={`Remove ${file.name}`}
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
