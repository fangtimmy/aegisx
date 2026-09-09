import { Download, FileArchive, Trash2 } from "lucide-react"

import { type Attachment } from "@/api"
import { IconTooltip } from "@/components/shell/icon-tooltip"
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
import { formatBytes } from "@/lib/format"

export function AttachmentRow({
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
          render={
            <a
              aria-label={`下载 ${attachment.originalName}`}
              href={attachment.downloadUrl}
            />
          }
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

export function PendingFileRow({
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
