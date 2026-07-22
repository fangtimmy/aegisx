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
import type { RunFile, RunFileEntry } from "@/lib/api"
import { apiRequest } from "@/lib/api"
import { formatTime } from "./timeline"

function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function DirectoryEntry({
  entry,
  runId,
  onSelect,
  depth = 0,
}: {
  entry: RunFileEntry
  runId: string
  onSelect: (path: string) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const directory = useQuery({
    enabled: entry.type === "directory" && expanded,
    queryKey: ["runs", runId, "files", entry.path],
    queryFn: () =>
      apiRequest<RunFile>(
        `/runs/${runId}/files?path=${encodeURIComponent(entry.path)}`
      ),
  })
  const isDirectory = entry.type === "directory"
  const FolderIcon = expanded ? FolderOpen : Folder

  if (!isDirectory) {
    return (
      <Button
        aria-label={`Preview ${entry.name}`}
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
        aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
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
          <div
            className="flex items-center gap-2 py-1 text-muted-foreground text-xs"
            role="status"
            style={{ paddingLeft: `${depth * 16 + 40}px` }}
          >
            <Spinner aria-hidden="true" />
            Loading directory...
          </div>
        )}
        {directory.error && (
          <p
            className="py-1 text-destructive-foreground text-xs"
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
              key={child.path}
              onSelect={onSelect}
              runId={runId}
            />
          ))}
      </CollapsiblePanel>
    </Collapsible>
  )
}

export function FilesWorkspace({
  runId,
  enabled,
}: {
  runId: string
  enabled: boolean
}) {
  const [selectedPath, setSelectedPath] = useState<string>()
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
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
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }, [])

  const root = useQuery({
    enabled,
    queryKey: ["runs", runId, "files", ""],
    queryFn: () => apiRequest<RunFile>(`/runs/${runId}/files?path=`),
  })
  const selected = useQuery({
    enabled: enabled && Boolean(selectedPath),
    queryKey: ["runs", runId, "files", selectedPath ?? ""],
    queryFn: () =>
      apiRequest<RunFile>(
        `/runs/${runId}/files?path=${encodeURIComponent(selectedPath ?? "")}`
      ),
  })

  return (
    <div className="flex h-full min-h-0 px-6 py-4" ref={containerRef}>
      <section
        className="flex min-h-0 shrink-0 flex-col pr-2"
        style={{ width: sidebarWidth }}
      >
        <h3 className="mb-2 font-medium text-sm">Workspace files</h3>
        <ScrollArea className="flex-1" scrollFade>
          {root.isPending && (
            <div
              className="flex items-center gap-2 text-muted-foreground text-xs"
              role="status"
            >
              <Spinner aria-hidden="true" />
              Loading files...
            </div>
          )}
          {root.error && (
            <p className="text-destructive-foreground text-xs" role="alert">
              {root.error.message}
            </p>
          )}
          {root.data?.type === "directory" &&
            root.data.entries.length === 0 && (
              <p className="text-muted-foreground text-xs">
                Workspace is empty.
              </p>
            )}
          {root.data?.type === "directory" &&
            root.data.entries.map((entry) => (
              <DirectoryEntry
                entry={entry}
                key={entry.path}
                onSelect={setSelectedPath}
                runId={runId}
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
        <div className="absolute inset-y-0 -left-1 -right-1" />
        <div className="absolute inset-y-0 left-0 w-0.5 bg-transparent transition-colors group-hover:bg-primary/40 data-[active]:bg-primary" />
      </div>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col pl-4">
        <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
          <h3 className="min-w-0 truncate font-medium text-sm">
            {selectedPath || "Preview"}
          </h3>
          {selectedPath && (
            <Button
              aria-label={`Download ${selectedPath}`}
              render={
                <a
                  download
                  href={`/api/runs/${runId}/files/download?path=${encodeURIComponent(selectedPath)}`}
                />
              }
              variant="outline"
            >
              <Download /> Download
            </Button>
          )}
        </div>
        {!selectedPath && (
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyTitle>Select a file</EmptyTitle>
              <EmptyDescription>
                Choose a file from the workspace tree to preview it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {selected.isPending && selectedPath && (
          <div
            className="flex items-center gap-2 text-muted-foreground text-sm"
            role="status"
          >
            <Spinner aria-hidden="true" />
            Loading preview...
          </div>
        )}
        {selected.error && (
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>Unable to load file</AlertTitle>
            <AlertDescription>{selected.error.message}</AlertDescription>
          </Alert>
        )}
        {selected.data?.type === "text" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
              <span>{formatSize(selected.data.size)}</span>
              <span>Modified {formatTime(selected.data.modifiedAt)}</span>
              {selected.data.truncated && <span>Preview truncated</span>}
            </div>
            <ScrollArea className="flex-1" scrollFade>
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
                {selected.data.content}
              </pre>
            </ScrollArea>
          </div>
        )}
        {selected.data?.type === "binary" && (
          <Alert>
            <Info />
            <AlertTitle>Binary file</AlertTitle>
            <AlertDescription>
              Preview is unavailable. Size: {formatSize(selected.data.size)}.
              Modified: {formatTime(selected.data.modifiedAt)}.
            </AlertDescription>
          </Alert>
        )}
      </section>
    </div>
  )
}
