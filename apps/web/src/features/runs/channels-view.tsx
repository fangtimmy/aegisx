import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Hash,
  Paperclip,
  Send,
  Users,
  X,
} from "lucide-react"
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  channelsApi,
  keys,
  type ChannelMessageList,
  type ChannelMessagePublic,
  type ChannelPublic,
} from "@/api"
import { ListRow } from "@/components/list-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { parseLiveEvent } from "@/stream/parse-event"

import { appendChannelMessage, mergeChannelMessages } from "./channel-tail"

/** Timeline / rail reconciliation cadence — a 60s backstop against silent
 * SSE loss, not the primary delivery path (that is the channel stream). */
export const RECONCILE_INTERVAL_MS = 60_000
const PAGE_SIZE = 100

/** Stable empty fallback so `channels.data?.items ?? []` keeps one reference
   between polls (useMemo/useEffect deps stay stable). */
const NO_CHANNELS: ChannelPublic[] = []
/** Same-author consecutive messages within this window merge into one
 * group (Discord-style): only the group head shows avatar + author + time. */
const GROUP_WINDOW_MS = 5 * 60_000

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false })
}

function dayOf(iso: string): string {
  return new Date(iso).toDateString()
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

// --- message rendering (Discord-style grouped rows) -----------------------

/** 📎 attachment chip: the shared/ path (read directly — no download
 * endpoint in v19). Solver agents read /workspace/<path>; the scheduler
 * reads /challenges/<cid>/workspace/<path>. */
function AttachmentChip({
  file,
}: {
  file: ChannelMessagePublic["files"][number]
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs"
      title={file.path}
    >
      <Paperclip className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{file.filename}</span>
      <span className="shrink-0 text-muted-foreground">
        · {formatSize(file.size)}
      </span>
    </span>
  )
}

function MessageAvatar({ message }: { message: ChannelMessagePublic }) {
  if (message.authorType === "system") {
    return (
      <span
        aria-hidden
        className="absolute top-1 left-4 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
      >
        <Bot className="size-4" />
      </span>
    )
  }
  const tone =
    message.authorType === "user"
      ? "bg-primary text-primary-foreground"
      : "bg-secondary text-secondary-foreground"
  const initial = (message.authorName.trim()[0] ?? "?").toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-1 left-4 flex size-9 items-center justify-center rounded-lg text-sm font-semibold",
        tone
      )}
    >
      {initial}
    </span>
  )
}

/** One message row: group head carries avatar + author + time (+ ⚠ 紧急);
 * continuation rows only show the body, with the timestamp on hover. */
function MessageRow({
  message,
  first,
}: {
  message: ChannelMessagePublic
  first: boolean
}) {
  return (
    <div className="group/row relative px-3 py-0.5 pl-16 hover:bg-muted/40">
      {first ? (
        <MessageAvatar message={message} />
      ) : (
        <span className="top-0.5 left-3 hidden w-9 text-right text-[10px] leading-6 text-muted-foreground group-hover/row:block">
          {timeOf(message.createdAt)}
        </span>
      )}
      {first && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm leading-6 font-medium">
            {message.authorName}
          </span>
          <span className="text-xs text-muted-foreground">
            {timeOf(message.createdAt)}
          </span>
          {message.meta.urgent === true && (
            <Badge size="sm" variant="warning">
              ⚠ 紧急
            </Badge>
          )}
        </div>
      )}
      <div className="text-sm leading-6 wrap-break-word whitespace-pre-wrap">
        {!first && message.meta.urgent === true && (
          <Badge className="mr-1.5" size="sm" variant="warning">
            ⚠
          </Badge>
        )}
        {message.body}
      </div>
      {message.files.length > 0 && (
        <div className="my-1 flex flex-wrap gap-1.5">
          {message.files.map((file) => (
            <AttachmentChip file={file} key={file.path} />
          ))}
        </div>
      )}
    </div>
  )
}

function DayDivider({ iso }: { iso: string }) {
  const label = new Date(iso).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  })
  return (
    <div className="m-3 flex items-center gap-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

type MessageGroup = { dayStart: boolean; messages: ChannelMessagePublic[] }

/** Group consecutive same-author messages (≤5min gap); a day boundary both
 * breaks the group and marks it for a date divider. */
function groupMessages(items: ChannelMessagePublic[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let prevDay = ""
  for (const message of items) {
    const day = dayOf(message.createdAt)
    const dayStart = day !== prevDay
    prevDay = day
    const last = groups.at(-1)
    const prev = last?.messages.at(-1)
    const sameAuthor =
      prev !== undefined &&
      prev.authorType === message.authorType &&
      prev.authorAgentId === message.authorAgentId &&
      prev.authorName === message.authorName
    if (
      !dayStart &&
      sameAuthor &&
      new Date(message.createdAt).getTime() -
        new Date(prev!.createdAt).getTime() <
        GROUP_WINDOW_MS
    ) {
      last!.messages.push(message)
    } else {
      groups.push({ dayStart, messages: [message] })
    }
  }
  return groups
}

/** The grouped message list (shared by the IM view and the scheduler DM
 * tab). Parents own the scroll container. */
export function MessageList({
  messages,
}: {
  messages: ChannelMessagePublic[]
}) {
  const groups = groupMessages(messages)
  if (groups.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        尚无消息。
      </p>
    )
  }
  return (
    <div className="pb-2">
      {groups.map((group) => (
        <Fragment key={group.messages[0]!.id}>
          {group.dayStart && <DayDivider iso={group.messages[0]!.createdAt} />}
          <div className="mt-2">
            {group.messages.map((message, index) => (
              <MessageRow
                first={index === 0}
                key={message.id}
                message={message}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

// --- composer ---------------------------------------------------------------

/** The channel composer: a single rounded input container holding the
 * textarea + attachment chips + urgent switch + buttons. Posts as the user
 * (multipart) — urgent defaults on (a user IM post is rare and intended →
 * immediate delivery); off defers to the next flush tick. */
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
        queryKey: keys.channels.messages(channelKey),
      })
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <div className="shrink-0 px-3 pb-3">
      {error && <p className="px-1 pb-1 text-xs text-destructive">{error}</p>}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 px-3 py-2 shadow-xs">
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
                  className="-me-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[inherit] p-0 text-muted-foreground transition-colors outline-none hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={() =>
                    setFiles((prev) => prev.filter((_, i) => i !== index))
                  }
                  type="button"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <Textarea
            className="max-h-32 flex-1 text-sm [&_textarea]:max-h-32 [&_textarea]:min-h-6 [&_textarea]:px-0 [&_textarea]:py-1 [&_textarea]:text-sm"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // IME composition: Enter commits the composition, never sends.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === "Enter" && !event.shiftKey && text.trim()) {
                event.preventDefault()
                send.mutate()
              }
            }}
            placeholder="发送消息…"
            rows={1}
            unstyled
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
          <div
            className="flex shrink-0 cursor-pointer flex-col items-center gap-0.5 pb-1 text-[11px] leading-tight text-muted-foreground"
            title="紧急消息立即投递；关闭后等待下一次合并投递"
          >
            <Switch
              aria-label="紧急投递"
              checked={urgent}
              onCheckedChange={setUrgent}
            />
            紧急
          </div>
          <Button
            aria-label="添加附件"
            className="mb-1"
            disabled={files.length >= 8}
            onClick={() => fileInput.current?.click()}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Paperclip />
          </Button>
          <Button
            aria-label="发送"
            className="mb-1"
            disabled={!text.trim() || send.isPending}
            onClick={() => send.mutate()}
            size="icon-sm"
            type="button"
          >
            {send.isPending ? <Spinner /> : <Send />}
          </Button>
        </div>
      </div>
    </div>
  )
}

// --- timeline ---------------------------------------------------------------

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
  const queryClient = useQueryClient()

  // gcTime 0: leaving a channel drops its cached tail, so re-entering starts
  // from the full latest window (after=0) instead of a partial tail response.
  const tail = useQuery({
    queryKey: keys.channels.messages(channelKey),
    queryFn: () =>
      channelsApi.listChannelMessages(channelKey, newestId.current, PAGE_SIZE),
    refetchInterval: RECONCILE_INTERVAL_MS,
    gcTime: 0,
  })

  // Live channel pushes (SSE): append into the tail cache and advance the
  // after cursor so the reconciliation poll never re-fetches what the stream
  // delivered. EventSource reconnects natively; the server's snapshot replay
  // de-duplicates through mergeChannelMessages.
  useEffect(() => {
    const source = new EventSource(`/api/channels/${channelKey}/stream`)
    source.onmessage = (message) => {
      let payload: unknown
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      const event = parseLiveEvent(payload)
      if (event?.type !== "channel.message") return
      const live = event.message as ChannelMessagePublic
      queryClient.setQueryData<ChannelMessageList>(
        keys.channels.messages(channelKey),
        (prev) => appendChannelMessage(prev, live)
      )
      newestId.current = Math.max(newestId.current, live.id)
    }
    return () => source.close()
  }, [channelKey, queryClient])

  useEffect(() => {
    const data = tail.data
    if (!data) return
    gotFirstPage.current = true
    // Sticky: channels are append-only, so a hasMore from any window stays
    // true (the SSE snapshot replay may land before the wider HTTP window).
    setHasOlder((prev) => prev || data.hasMore)
    setItems((prev) => mergeChannelMessages(prev, data.items))
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
        <Spinner aria-hidden /> 正在加载消息…
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="h-full overflow-y-auto pt-1"
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
        <MessageList messages={items} />
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

// --- channel rail -----------------------------------------------------------

function RailItem({
  channel,
  active,
  onSelect,
  unseen,
}: {
  channel: ChannelPublic
  active: boolean
  onSelect: () => void
  unseen: boolean
}) {
  return (
    <ListRow
      className="items-center gap-1.5 hover:bg-muted data-selected:bg-muted data-selected:font-medium"
      key={channel.key}
      onClick={onSelect}
      selected={active}
    >
      {channel.kind === "dm" ? (
        <span className="font-mono text-xs text-muted-foreground">DM</span>
      ) : (
        <Hash className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{channel.label}</span>
      {channel.liveAgentCount !== null && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 font-mono text-[11px] leading-4 text-muted-foreground"
          title={`同题共享频道 · ${channel.liveAgentCount} 个 live agent`}
        >
          <Users className="size-2.5" aria-hidden />
          {channel.liveAgentCount}
        </span>
      )}
      {unseen && (
        <span
          aria-label="未读"
          className="ml-auto size-2 shrink-0 rounded-full bg-primary"
        />
      )}
    </ListRow>
  )
}

/** The left rail: 频道 (team/orch) + 私聊 (dm) sections. */
function ChannelRail({
  channels,
  activeKey,
  onSelect,
  unseenKeys,
}: {
  channels: ChannelPublic[]
  activeKey: string | null
  onSelect: (key: string) => void
  unseenKeys: Set<string>
}) {
  const sections: Array<{ label: string; items: ChannelPublic[] }> = [
    { label: "频道", items: channels.filter((c) => c.kind !== "dm") },
    { label: "私聊", items: channels.filter((c) => c.kind === "dm") },
  ].filter((section) => section.items.length > 0)
  return (
    <div className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto border-r p-2">
      {sections.map((section) => (
        <div className="flex flex-col gap-0.5" key={section.label}>
          <p className="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {section.label}
          </p>
          {section.items.map((channel) => (
            <RailItem
              active={channel.key === activeKey}
              channel={channel}
              key={channel.key}
              onSelect={() => onSelect(channel.key)}
              unseen={unseenKeys.has(channel.key)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// --- the IM view ------------------------------------------------------------

/**
 * The IM view (v19 派生键频道): channel rail + message timeline + composer
 * with attachments + urgent switch. Anchored on a challenge (its channel
 * tree: #team + one DM per agent that ever attacked the challenge).
 * Channels are addressed by their derived `key` (team:<cid> / dm:<aid>).
 * UI unread is client-side session state — never persisted.
 */
export function ChannelsView({ challengeId }: { challengeId?: string }) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  /** Session-local unread baseline (UI unread is client session state,
   * never persisted): channel key → the last message timestamp this view has
   * accounted for. A channel whose live `lastMessageAt` is newer shows an
   * unread dot. */
  const [seenAt, setSeenAt] = useState<Record<string, string | null>>({})

  const channels = useQuery({
    queryKey: challengeId
      ? keys.challenges.channels(challengeId)
      : ["channels", "none"],
    enabled: Boolean(challengeId),
    queryFn: () => channelsApi.getChallengeChannels(challengeId!),
    refetchInterval: RECONCILE_INTERVAL_MS,
  })

  const list = channels.data?.items ?? NO_CHANNELS
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

  const unseenKeys = new Set(
    list
      .filter(
        (channel) =>
          channel.key !== active?.key &&
          channel.lastMessageAt !== null &&
          channel.lastMessageAt !== seenAt[channel.key]
      )
      .map((channel) => channel.key)
  )

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <ChannelRail
        activeKey={active?.key ?? null}
        channels={list}
        onSelect={setActiveKey}
        unseenKeys={unseenKeys}
      />
      {/* Timeline + composer */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2 text-sm font-medium">
          {active?.kind === "dm" ? (
            <span className="font-mono text-xs text-muted-foreground">DM</span>
          ) : (
            <Hash className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{active?.label ?? "频道"}</span>
        </div>
        {active && <ChannelTimeline channelKey={active.key} key={active.key} />}
        {active && <ChannelComposer channelKey={active.key} />}
      </div>
    </div>
  )
}
