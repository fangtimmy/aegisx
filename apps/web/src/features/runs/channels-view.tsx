import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Hash, Paperclip, Send, Users, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { channelsApi, keys, type ChannelMessageInfo } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** Composer + timeline refresh cadence. */
const POLL_INTERVAL_MS = 3000
const PAGE_SIZE = 100

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)}KB`
  }
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}MB`
}

function authorBadgeVariant(
  authorType: ChannelMessageInfo["authorType"]
): "secondary" | "info" | "outline" {
  if (authorType === "system") return "secondary"
  if (authorType === "user") return "info"
  return "outline"
}

/** 📎 attachment chip (metadata only — content downloads on click). */
function AttachmentChip({
  file,
}: {
  file: ChannelMessageInfo["files"][number]
}) {
  return (
    <a
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs hover:bg-muted"
      download
      href={channelsApi.channelFileUrl(file.id)}
    >
      <Paperclip className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{file.filename}</span>
      <span className="shrink-0 text-muted-foreground">
        · {formatSize(file.size)}
      </span>
    </a>
  )
}

export function MessageBubble({ message }: { message: ChannelMessageInfo }) {
  if (message.kind === "recap") {
    return (
      <div className="flex flex-col gap-1 border-y bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium">── 摘要</span>
          <span>{timeOf(message.createdAt)}</span>
          <span>（投递历史）</span>
        </div>
        <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
          {message.body}
        </pre>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge size="sm" variant={authorBadgeVariant(message.authorType)}>
          {message.authorName}
        </Badge>
        <span>{timeOf(message.createdAt)}</span>
      </div>
      <div className="text-sm whitespace-pre-wrap">{message.body}</div>
      {message.files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.files.map((file) => (
            <AttachmentChip file={file} key={file.id} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The channel composer: textarea + attachment picker + send. Posts as the
 * user (multipart) — same ledger + delivery policy as SDK/system posts. */
export function ChannelComposer({ channelId }: { channelId: string }) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const send = useMutation({
    mutationFn: () =>
      channelsApi.postChannelMessage(channelId, {
        text: text.trim(),
        files: files.length ? files : undefined,
      }),
    onSuccess: () => {
      setText("")
      setFiles([])
      if (fileInput.current) fileInput.current.value = ""
      setError(null)
      void queryClient.invalidateQueries({
        queryKey: keys.runs.channelMessages(channelId),
      })
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t px-3 py-2">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <span
              className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs"
              key={`${file.name}-${index}`}
            >
              <Paperclip className="size-3" aria-hidden />
              {file.name} · {formatSize(file.size)}
              <button
                aria-label={`移除附件 ${file.name}`}
                onClick={() =>
                  setFiles((prev) => prev.filter((_, i) => i !== index))
                }
                type="button"
              >
                <X className="size-3 hover:text-destructive" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          className="max-h-32 min-h-9 flex-1 resize-none"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && text.trim()) {
              event.preventDefault()
              send.mutate()
            }
          }}
          placeholder="发送消息…（Enter 发送，Shift+Enter 换行）"
          rows={1}
          value={text}
        />
        <input
          className="hidden"
          multiple
          onChange={(event) =>
            setFiles([...(event.target.files ?? [])].slice(0, 8))
          }
          ref={fileInput}
          type="file"
        />
        <Button
          aria-label="添加附件"
          disabled={files.length >= 8}
          onClick={() => fileInput.current?.click()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Paperclip />
        </Button>
        <Button
          disabled={!text.trim() || send.isPending}
          onClick={() => send.mutate()}
          size="sm"
          type="button"
        >
          {send.isPending ? <Spinner /> : <Send />} 发送
        </Button>
      </div>
    </div>
  )
}

/**
 * The per-run IM view (docs/im-channels.md §5.2): channel rail (#announce /
 * #team / DM per solver) + message timeline + composer with attachments.
 * UI unread is client-side session state (messages newer than the last id
 * seen at mount / on channel switch) — never persisted.
 */
export function ChannelsView({ runId }: { runId: string }) {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Session-local unread baseline (design §5.2: UI unread is client session
   * state, never persisted): channel id → the last message timestamp this
   * view has accounted for. A channel whose live `lastMessageAt` is newer
   * shows an unread dot. */
  const [seenAt, setSeenAt] = useState<Record<string, string | null>>({})
  const timelineRef = useRef<HTMLDivElement>(null)

  const channels = useQuery({
    queryKey: keys.runs.channels(runId),
    queryFn: () => channelsApi.getRunChannels(runId),
    refetchInterval: POLL_INTERVAL_MS,
  })

  const list = channels.data?.items ?? []
  const active = list.find((channel) => channel.id === activeId) ?? list[0]

  // Baseline unseen channels on first load (0 unread at mount).
  useEffect(() => {
    setSeenAt((prev) => {
      let changed = false
      const next = { ...prev }
      for (const channel of list) {
        if (!(channel.id in next)) {
          next[channel.id] = channel.lastMessageAt
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [list])

  const messages = useQuery({
    queryKey: keys.runs.channelMessages(active?.id ?? ""),
    enabled: Boolean(active),
    queryFn: () => channelsApi.listChannelMessages(active!.id, 0, PAGE_SIZE),
    refetchInterval: POLL_INTERVAL_MS,
  })

  // Mark the open channel read: the newest loaded message timestamp becomes
  // its seen baseline.
  useEffect(() => {
    if (!messages.data || !active) return
    const newest = messages.data.items.at(-1)?.createdAt ?? null
    setSeenAt((prev) =>
      prev[active.id] === newest ? prev : { ...prev, [active.id]: newest }
    )
  }, [messages.data, active])

  // Auto-scroll to the newest message.
  useEffect(() => {
    const node = timelineRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.data])

  const items = messages.data?.items ?? []

  return (
    <div className="flex h-full min-h-0 min-w-0">
      {/* Channel rail */}
      <div className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        {channels.isPending && (
          <p className="px-2 py-1 text-xs text-muted-foreground">加载中…</p>
        )}
        {list.map((channel) => {
          const unseen =
            channel.id !== active?.id &&
            channel.lastMessageAt !== null &&
            channel.lastMessageAt !== seenAt[channel.id]
          return (
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                channel.id === active?.id && "bg-muted font-medium"
              )}
              key={channel.id}
              onClick={() => setActiveId(channel.id)}
              type="button"
            >
              {channel.kind === "dm" ? (
                <span className="font-mono text-xs text-muted-foreground">
                  DM
                </span>
              ) : (
                <Hash className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{channel.label}</span>
              {/* v17：题目级共享频道（同题全部 live run 同一频道 + 历史） */}
              {channel.sharedRunCount !== null && (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground"
                  title={`同题共享频道 · ${channel.sharedRunCount} 个 live run`}
                >
                  <Users className="size-2.5" aria-hidden />
                  {channel.sharedRunCount}
                </span>
              )}
              {unseen && (
                <span
                  aria-label="未读"
                  className="ml-auto size-2 shrink-0 rounded-full bg-primary"
                />
              )}
            </button>
          )
        })}
      </div>
      {/* Timeline + composer */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-sm font-medium">
          {active?.label ?? "频道"}
        </div>
        {messages.isPending ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden /> 加载中…
          </div>
        ) : (
          <div
            className="flex-1 overflow-y-auto py-2"
            ref={timelineRef}
            role="log"
          >
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                尚无消息。
              </p>
            )}
            {items.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
        {active && <ChannelComposer channelId={active.id} />}
      </div>
    </div>
  )
}
