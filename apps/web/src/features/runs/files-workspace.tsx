import { formatSize } from "@aegisx/shared"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  File,
  Folder,
  FolderOpen,
  Info,
} from "lucide-react"
import { useCallback, useRef, useState } from "react"

import { type WorkspaceFile, type WorkspaceFileEntry } from "@/api"
import { CodePreview } from "@/components/code-preview"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { formatTime } from "@/lib/format"

const SIDEBAR_STORAGE_KEY = "aegisx:files-sidebar-width"
const SIDEBAR_DEFAULT = 288
const SIDEBAR_MIN = 200
const SIDEBAR_MAX_RATIO = 0.6

function readStoredWidth(): number {
  const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
  if (!stored) return SIDEBAR_DEFAULT
  const n = Number(stored)
  return Number.isFinite(n) && n >= SIDEBAR_MIN ? n : SIDEBAR_DEFAULT
}

function DirectoryEntry({
  entry,
  files,
  onSelect,
  depth = 0,
  defaultExpanded = false,
}: {
  entry: WorkspaceFileEntry
  files: FilesApi
  onSelect: (path: string) => void
  depth?: number
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const directory = useQuery({
    enabled: entry.type === "directory" && expanded,
    queryKey: files.key(entry.path),
    queryFn: () => files.get(entry.path),
  })
  const isDirectory = entry.type === "directory"
  const FolderIcon = expanded ? FolderOpen : Folder

  if (!isDirectory) {
    return (
      <Button
        aria-label={`预览 ${entry.name}`}
        className="h-8 w-full justify-start gap-1.5 px-2 text-left text-xs"
        onClick={() => onSelect(entry.path)}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        type="button"
        variant="ghost"
      >
        <span className="size-3.5" />
        <File className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        <span className="text-muted-foreground">{formatSize(entry.size)}</span>
      </Button>
    )
  }

  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <CollapsibleTrigger
        aria-label={`${expanded ? "折叠" : "展开"} ${entry.name}`}
        render={
          <Button
            className="h-8 w-full justify-start gap-1.5 px-2 text-left text-xs"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            type="button"
            variant="ghost"
          />
        }
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <FolderIcon className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {directory.isPending && (
          <output
            className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: `${depth * 16 + 40}px` }}
          >
            <Spinner aria-hidden="true" />
            正在加载目录…
          </output>
        )}
        {directory.error && (
          <p
            className="py-1 text-xs text-destructive-foreground"
            role="alert"
            style={{ paddingLeft: `${depth * 16 + 40}px` }}
          >
            {directory.error.message}
          </p>
        )}
        {directory.data?.type === "directory" &&
          directory.data.entries.map((child) => (
            <DirectoryEntry
              depth={depth + 1}
              entry={child}
              files={files}
              key={child.path}
              onSelect={onSelect}
            />
          ))}
      </CollapsiblePanel>
    </Collapsible>
  )
}

/** Adapter that fetches a workspace tree + builds a download URL. Lets the
 * same browser serve a solver run (/api/runs/:id/files) and the per-event
 * orchestrator (/api/events/:id/orchestrator/files) without knowing which. */
export type FilesApi = {
  /** React Query key for a path (stable per path). */
  key: (path: string) => readonly unknown[]
  /** Fetch a file/directory entry at a path. */
  get: (path: string) => Promise<WorkspaceFile>
  /** Download URL for a path (anchor href). */
  downloadUrl: (path: string) => string
}

export function FilesWorkspace({
  files,
  enabled,
  rootLabel = "任务文件",
}: {
  files: FilesApi
  enabled: boolean
  rootLabel?: string
}) {
  const [selectedPath, setSelectedPath] = useState<string>()
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      if (e.target instanceof HTMLElement)
        e.target.setPointerCapture(e.pointerId)
      dragState.current = { startX: e.clientX, startWidth: sidebarWidth }
    },
    [sidebarWidth]
  )

  const onHandlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return
    const container = containerRef.current
    if (!container) return
    const max = container.clientWidth * SIDEBAR_MAX_RATIO
    const delta = e.clientX - dragState.current.startX
    const next = Math.min(
      Math.max(dragState.current.startWidth + delta, SIDEBAR_MIN),
      max
    )
    setSidebarWidth(next)
  }, [])

  const onHandlePointerUp = useCallback((e: React.PointerEvent) => {
    if (dragState.current) {
      dragState.current = null
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(w)))
        return w
      })
    }
    if (e.target instanceof HTMLElement)
      e.target.releasePointerCapture?.(e.pointerId)
  }, [])

  const root = useQuery({
    enabled,
    queryKey: files.key(""),
    queryFn: () => files.get(""),
  })
  const selected = useQuery({
    enabled: enabled && Boolean(selectedPath),
    queryKey: files.key(selectedPath ?? ""),
    queryFn: () => files.get(selectedPath ?? ""),
  })

  return (
    <div className="flex h-full min-h-0 px-6 py-4" ref={containerRef}>
      <section
        className="flex min-h-0 shrink-0 flex-col pr-2"
        style={{ width: sidebarWidth }}
      >
        <h3 className="mb-2 text-sm font-medium">{rootLabel}</h3>
        <ScrollArea className="flex-1" scrollFade>
          {root.isPending && (
            <output className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner aria-hidden="true" />
              正在加载文件…
            </output>
          )}
          {root.error && (
            <p className="text-xs text-destructive-foreground" role="alert">
              {root.error.message}
            </p>
          )}
          {root.data?.type === "directory" &&
            root.data.entries.length === 0 && (
              <p className="text-xs text-muted-foreground">任务目录为空。</p>
            )}
          {root.data?.type === "directory" &&
            root.data.entries.map((entry) => (
              <DirectoryEntry
                defaultExpanded={entry.name === "workspace"}
                entry={entry}
                files={files}
                key={entry.path}
                onSelect={setSelectedPath}
              />
            ))}
        </ScrollArea>
      </section>
      <div
        aria-hidden="true"
        className="group relative w-px shrink-0 cursor-col-resize bg-border"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
      >
        <div className="absolute inset-y-0 -right-1 -left-1" />
        <div className="absolute inset-y-0 left-0 w-0.5 bg-transparent transition-colors group-hover:bg-primary/40 data-[active]:bg-primary" />
      </div>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col pl-4">
        <div className="mb-2 flex min-h-8 items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <h3 className="truncate text-sm font-medium">
              {selectedPath || "预览"}
            </h3>
            {selected.data?.type === "text" && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{formatSize(selected.data.size)}</span>
                <span>修改于 {formatTime(selected.data.modifiedAt)}</span>
                {selected.data.truncated && <span>预览已截断</span>}
              </div>
            )}
          </div>
          {selectedPath && (
            <Button
              render={
                <a
                  aria-label={`下载 ${selectedPath}`}
                  download
                  href={files.downloadUrl(selectedPath)}
                />
              }
              variant="outline"
            >
              <Download /> 下载
            </Button>
          )}
        </div>
        {!selectedPath && (
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyTitle>选择一个文件</EmptyTitle>
              <EmptyDescription>
                从工作区目录树中选择文件以预览。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {selected.isPending && selectedPath && (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            正在加载预览…
          </output>
        )}
        {selected.error && (
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>无法加载文件</AlertTitle>
            <AlertDescription>{selected.error.message}</AlertDescription>
          </Alert>
        )}
        {selected.data?.type === "text" && (
          <ScrollArea className="flex min-h-0 flex-1" scrollFade>
            <CodePreview
              code={selected.data.content}
              path={selectedPath ?? selected.data.path}
            />
          </ScrollArea>
        )}
        {selected.data?.type === "binary" && (
          <Alert>
            <Info />
            <AlertTitle>二进制文件</AlertTitle>
            <AlertDescription>
              无法预览。大小：{formatSize(selected.data.size)}。修改于：
              {formatTime(selected.data.modifiedAt)}。
            </AlertDescription>
          </Alert>
        )}
      </section>
    </div>
  )
}
