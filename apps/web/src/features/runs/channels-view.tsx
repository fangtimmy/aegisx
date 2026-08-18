import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Hash,
  Paperclip,
  Send,
  Users,
  X,
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { channelsApi, keys, type ChannelMessagePublic } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
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
  authorType: ChannelMessagePublic["authorType"]
): "secondary" | "info" | "outline" {
  if (authorType === "system") return "secondary"
  if (authorType === "user") return "info"
  return "outline"
}

/** 📎 attachment chip (metadata only — content downloads on click). */
function AttachmentChip({
  file,
}: {
  file: ChannelMessagePublic["files"][number]
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

export function MessageBubble({ message }: { message: ChannelMessagePublic }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge size="sm" variant={authorBadgeVariant(message.authorType)}>
          {message.authorName}
        </Badge>
        <span>{timeOf(message.createdAt)}</span>
        {message.meta.urgent === true && (
          <Badge size="sm" variant="warning">
            ⚠ 紧急
          </Badge>
        )}
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

/** The channel composer: textarea + attachment picker + urgent switch +
 * send. Posts as the user (multipart) — urgent defaults on (a user IM post
 * is rare and intended → immediate delivery); off defers to the next flush
 * tick. */
export function ChannelComposer({ channelKey }: { channelKey: string }) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [urgent, setUrgent] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const send = useMutation({
    mutationFn: () =>
      channelsApi.postChannelMessage(channelKey, {
        text: text.trim(),
        files: files.length ? files : undefined,
        urgent,
      }),
    onSuccess: () => {
      setText("")
      setFiles([])
      if (fileInput.current) fileInput.current.value = ""
      setError(null)
      void queryClient.invalidateQueries({
        queryKey: keys.runs.channelMessages(channelKey),
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
        <label
          className="flex shrink-0 cursor-pointer flex-col items-center gap-0.5 text-[10px] leading-3 text-muted-foreground"
          title="紧急消息立即投递；关闭后等待下一次合并投递"
        >
          <Switch
            aria-label="紧急投递"
            checked={urgent}
            onCheckedChange={setUrgent}
          />
          紧急
        </label>
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
 * The open channel's timeline. Loads the latest window once, then tails via
 * the `after` cursor (poll); "加载更早" pages backwards via the `before`
 * cursor with the viewport anchored. Follows the latest message unless the
 * user scrolled up (a jump button returns); prepending history keeps the
 * viewport anchored.
 */
function ChannelTimeline({ channelKey }: { channelKey: string }) {
  const [items, setItems] = useState<ChannelMessagePublic[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const followsLatest = useRef(true)
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const newestId = useRef(0)
  const gotFirstPage = useRef(false)

  // gcTime 0: leaving a channel drops its cached tail, so re-entering starts
  // from the full latest window (after=0) instead of a partial tail response.
  const tail = useQuery({
    queryKey: keys.runs.channelMessages(channelKey),
    queryFn: () =>
      channelsApi.listChannelMessages(channelKey, newestId.current, PAGE_SIZE),
    refetchInterval: POLL_INTERVAL_MS,
    gcTime: 0,
  })

  useEffect(() => {
    const data = tail.data
    if (!data) return
    const first = !gotFirstPage.current
    gotFirstPage.current = true
    setItems((prev) => {
      if (first) return data.items
      const seen = new Set(prev.map((message) => message.id))
      const fresh = data.items.filter((message) => !seen.has(message.id))
      return fresh.length > 0 ? [...prev, ...fresh] : prev
    })
    if (first) setHasOlder(data.hasMore)
  }, [tail.data])

  useEffect(() => {
    newestId.current = items.at(-1)?.id ?? 0
  }, [items])

  const loadOlder = async () => {
    const oldest = items[0]?.id
    if (oldest === undefined || loadingOlder) return
    const el = listRef.current
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop }
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const data = await channelsApi.listChannelMessages(
        channelKey,
        0,
        PAGE_SIZE,
        oldest
      )
      setItems((prev) => {
        const seen = new Set(prev.map((message) => message.id))
        const older = data.items.filter((message) => !seen.has(message.id))
        return older.length > 0 ? [...older, ...prev] : prev
      })
      setHasOlder(data.hasMore)
    } catch (error) {
      setOlderError(error instanceof Error ? error.message : "加载失败")
    } finally {
      setLoadingOlder(false)
    }
  }

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 4
    followsLatest.current = atBottom
    setShowJump(!atBottom)
  }

  // After a prepend, restore the viewport position (scrollHeight grew by the
  // inserted history); otherwise follow the tail when the user is at bottom.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (anchor.current) {
      el.scrollTop =
        anchor.current.top + (el.scrollHeight - anchor.current.height)
      anchor.current = null
    } else if (followsLatest.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  const jumpToLatest = () => {
    followsLatest.current = true
    setShowJump(false)
    const el = listRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }

  if (tail.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden /> 加载中…
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="h-full overflow-y-auto py-2"
        onScroll={onScroll}
        ref={listRef}
        role="log"
      >
        {hasOlder && (
          <div className="flex justify-center pb-2">
            {olderError ? (
              <p className="text-xs text-destructive">{olderError}</p>
            ) : (
              <Button
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
                size="sm"
                type="button"
                variant="ghost"
              >
                {loadingOlder ? <Spinner /> : <ArrowUp />} 加载更早消息
              </Button>
            )}
          </div>
        )}
        {items.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            尚无消息。
          </p>
        )}
        {items.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
      {showJump && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Button
            className="pointer-events-auto"
            onClick={jumpToLatest}
            size="sm"
            type="button"
          >
            <ArrowDown aria-hidden /> 最新
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The IM view (v18 派生键频道): channel rail + message timeline + composer
 * with attachments + urgent switch. Two data sources:
 *  - runId: a run's tree (#team + one DM per solver, derived keys)
 *  - challengeId: the challenge's single #team (v17 knowledge base, shared
 *    across the challenge's runs — the 共享 badge)
 * Channels are addressed by their derived `key` (team:<cid> / dm:<aid>).
 * UI unread is client-side session state (the open channel's baseline is the
 * latest message the rail poll has seen for it) — never persisted.
 */
export function ChannelsView({
  runId,
  challengeId,
}: {
  runId?: string
  challengeId?: string
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  /** Session-local unread baseline (UI unread is client session state,
   * never persisted): channel key → the last message timestamp this view has
   * accounted for. A channel whose live `lastMessageAt` is newer shows an
   * unread dot. */
  const [seenAt, setSeenAt] = useState<Record<string, string | null>>({})

  const channels = useQuery({
    queryKey: challengeId
      ? keys.challenges.channels(challengeId)
      : keys.runs.channels(runId ?? ""),
    enabled: Boolean(challengeId ?? runId),
    queryFn: () =>
      challengeId
        ? channelsApi.getChallengeChannels(challengeId)
        : channelsApi.getRunChannels(runId!),
    refetchInterval: POLL_INTERVAL_MS,
  })

  const list = channels.data?.items ?? []
  const active = list.find((channel) => channel.key === activeKey) ?? list[0]

  // Baseline unseen channels on first load (0 unread at mount).
  useEffect(() => {
    setSeenAt((prev) => {
      let changed = false
      const next = { ...prev }
      for (const channel of list) {
        if (!(channel.key in next)) {
          next[channel.key] = channel.lastMessageAt
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [list])

  // The open channel is read: its latest rail-known message timestamp is
  // the seen baseline (the rail poll carries lastMessageAt).
  const activeKeyResolved = active?.key
  const activeLastMessageAt = active?.lastMessageAt
  useEffect(() => {
    if (!activeKeyResolved) return
    setSeenAt((prev) =>
      prev[activeKeyResolved] === activeLastMessageAt
        ? prev
        : { ...prev, [activeKeyResolved]: activeLastMessageAt }
    )
  }, [activeKeyResolved, activeLastMessageAt])

  return (
    <div className="flex h-full min-h-0 min-w-0">
      {/* Channel rail */}
      <div className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        {channels.isPending && (
          <p className="px-2 py-1 text-xs text-muted-foreground">加载中…</p>
        )}
        {list.map((channel) => {
          const unseen =
            channel.key !== active?.key &&
            channel.lastMessageAt !== null &&
            channel.lastMessageAt !== seenAt[channel.key]
          return (
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                channel.key === active?.key && "bg-muted font-medium"
              )}
              key={channel.key}
              onClick={() => setActiveKey(channel.key)}
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
              {/* v17/v18：题目级共享频道（同题全部 live run 同一频道 + 历史） */}
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
        {active && <ChannelTimeline channelKey={active.key} key={active.key} />}
        {active && <ChannelComposer channelKey={active.key} />}
      </div>
    </div>
  )
}
