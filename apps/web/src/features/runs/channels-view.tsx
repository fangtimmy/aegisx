import { formatSize } from "@aegisx/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Download,
  Hash,
  LoaderCircle,
  Paperclip,
  Send,
  Users,
  X,
} from "lucide-react"
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import {
  apiUrl,
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
import { formatTimeWithSeconds } from "@/lib/format"
import { cn } from "@/lib/utils"
import { liveConnection } from "@/stream/live-connection"

import { appendChannelMessage, mergeChannelMessages } from "./channel-tail"
import { MessageComposer } from "./composer"
import { useChannelSeen } from "./use-channel-seen"

/** Timeline / rail reconciliation cadence — a 60s backstop against silent
 * SSE loss, not the primary delivery path (that is the channel stream). */
const RECONCILE_INTERVAL_MS = 60_000
const PAGE_SIZE = 100

/** Stable empty fallback so `channels.data?.items ?? []` keeps one reference
   between polls (useMemo/useEffect deps stay stable). */
const NO_CHANNELS: ChannelPublic[] = []
/** Same-author consecutive messages within this window merge into one
 * group (Discord-style): only the group head shows avatar + author + time. */
const GROUP_WINDOW_MS = 5 * 60_000

function dayOf(iso: string): string {
  return new Date(iso).toDateString()
}

// --- message rendering (Discord-style grouped rows) -----------------------

/** 📎 attachment chip → download link. Files live in the challenge
 * workspace's shared/ tree; the channel endpoint resolves the message +
 * path back to that workspace (team → the challenge, dm → the target's,
 * orch → the author's). */
function AttachmentChip({
  file,
  message,
}: {
  file: ChannelMessagePublic["files"][number]
  message: ChannelMessagePublic
}) {
  const url = apiUrl(
    `/channels/${message.channelKey}/files/download?message=${message.id}&path=${encodeURIComponent(file.path)}`
  )
  return (
    <a
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs transition-colors hover:bg-accent"
      download
      href={url}
      title={`下载 ${file.filename}（${file.path}）`}
    >
      <Paperclip className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{file.filename}</span>
      <span className="shrink-0 text-muted-foreground">
        · {formatSize(file.size)}
      </span>
      <Download aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </a>
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
const MessageRow = memo(function MessageRow({
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
        <span className="top-0.5 left-3 hidden w-9 text-right text-2xs leading-6 text-muted-foreground group-hover/row:block">
          {formatTimeWithSeconds(message.createdAt)}
        </span>
      )}
      {first && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm leading-6 font-medium">
            {message.authorName}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatTimeWithSeconds(message.createdAt)}
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
            <AttachmentChip file={file} key={file.path} message={message} />
          ))}
        </div>
      )}
    </div>
  )
})

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
        new Date(prev.createdAt).getTime() <
        GROUP_WINDOW_MS
    ) {
      last!.messages.push(message)
    } else {
      groups.push({ dayStart, messages: [message] })
    }
  }
  return groups
}

/** The grouped message list (inside both timelines). Parents own the scroll
 * container. */
function MessageList({ messages }: { messages: ChannelMessagePublic[] }) {
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
        <Fragment key={group.messages[0].id}>
          {group.dayStart && <DayDivider iso={group.messages[0].createdAt} />}
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

  const submit = () => {
    if (text.trim() && !send.isPending) send.mutate()
  }

  return (
    <div className="shrink-0 px-3 pb-3">
      {error && <p className="px-1 pb-1 text-xs text-destructive">{error}</p>}
      <MessageComposer
        above={
          files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
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
          )
        }
        ariaLabel="发送频道消息"
        onChange={setText}
        onSubmit={submit}
        placeholder="发送消息…"
        value={text}
      >
        <div
          className="flex shrink-0 cursor-pointer flex-col items-center gap-0.5 text-2xs leading-tight text-muted-foreground"
          title="紧急消息立即投递；关闭后等待下一次合并投递"
        >
          <Switch
            aria-label="紧急投递"
            checked={urgent}
            onCheckedChange={setUrgent}
          />
          紧急
        </div>
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
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Paperclip />
        </Button>
        <Button
          aria-label="发送"
          className="ml-auto"
          disabled={!text.trim() || send.isPending}
          onClick={submit}
          size="icon-sm"
          type="button"
        >
          {send.isPending ? <Spinner /> : <Send />}
        </Button>
      </MessageComposer>
    </div>
  )
}

// --- timeline ---------------------------------------------------------------

/**
 * The open channel's timeline (shared by the IM view and the scheduler DM
 * tab). Loads the latest window once, then tails via the `after` cursor
 * (poll); "加载更早" pages backwards via the `before` cursor with the
 * viewport anchored. Follows the latest message unless the user scrolled up
 * (a jump button returns); prepending history keeps the viewport anchored.
 * `active=false` (a hidden keepMounted tab) stops polling + the SSE stream.
 */
export function ChannelTimeline({
  channelKey,
  active = true,
}: {
  channelKey: string
  active?: boolean
}) {
  const [items, setItems] = useState<ChannelMessagePublic[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
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
    refetchInterval: active ? RECONCILE_INTERVAL_MS : false,
    gcTime: 0,
  })

  // Live channel pushes ride the app's multiplexed connection: append into the
  // tail cache and advance the after cursor so the reconciliation poll never
  // re-fetches what the stream delivered. Duplicates are idempotent
  // (appendChannelMessage de-duplicates by id); a reconnect invalidates the
  // tail so the window is re-read instead of trusting a gap.
  useEffect(() => {
    if (!active) return undefined
    const unsubscribe = liveConnection.subscribe((event) => {
      if (
        event.type !== "channel.message" ||
        event.message.channelKey !== channelKey
      ) {
        return
      }
      queryClient.setQueryData<ChannelMessageList>(
        keys.channels.messages(channelKey),
        (prev) => appendChannelMessage(prev, event.message)
      )
      newestId.current = Math.max(newestId.current, event.message.id)
    })
    const offStatus = liveConnection.onStatus(setDisconnected)
    const offReconnect = liveConnection.onReconnect(() => {
      void queryClient.invalidateQueries({
        queryKey: keys.channels.messages(channelKey),
      })
    })
    return () => {
      unsubscribe()
      offStatus()
      offReconnect()
    }
  }, [active, channelKey, queryClient])

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
  if (tail.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm">
        <p className="text-destructive">消息加载失败：{tail.error.message}</p>
        <Button onClick={() => void tail.refetch()} size="sm" variant="outline">
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto pt-1"
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
      {disconnected && (
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" /> 正在重新连接…
        </div>
      )}
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
  unread,
}: {
  channel: ChannelPublic
  active: boolean
  onSelect: () => void
  unread: boolean
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
          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 font-mono text-2xs leading-4 text-muted-foreground"
          title={`同题共享频道 · ${channel.liveAgentCount} 个 live agent`}
        >
          <Users className="size-2.5" aria-hidden />
          {channel.liveAgentCount}
        </span>
      )}
      {unread && (
        <span
          aria-label="有未读消息"
          className="ml-auto inline-flex size-2 shrink-0 rounded-full bg-primary"
        />
      )}
    </ListRow>
  )
}

/** The left rail: 频道 (team/orch) + 私聊 (dm) sections. */
function ChannelRail({
  channels,
  activeKey,
  isUnread,
  onSelect,
}: {
  channels: ChannelPublic[]
  activeKey: string | null
  isUnread: (channel: ChannelPublic) => boolean
  onSelect: (key: string) => void
}) {
  const sections: Array<{ label: string; items: ChannelPublic[] }> = [
    { label: "频道", items: channels.filter((c) => c.kind !== "dm") },
    { label: "私聊", items: channels.filter((c) => c.kind === "dm") },
  ].filter((section) => section.items.length > 0)
  return (
    <div className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto border-r p-2">
      {sections.map((section) => (
        <div className="flex flex-col gap-0.5" key={section.label}>
          <p className="px-2 pt-1 pb-0.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {section.label}
          </p>
          {section.items.map((channel) => (
            <RailItem
              active={channel.key === activeKey}
              channel={channel}
              key={channel.key}
              onSelect={() => onSelect(channel.key)}
              unread={isUnread(channel)}
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
 * Unread is the shared localStorage seen-marker store (`useChannelSeen`) —
 * the same source the task tab badge reads, so the two never disagree.
 */
export function ChannelsView({ challengeId }: { challengeId?: string }) {
  const [activeKey, setActiveKey] = useState<string | null>(null)

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
  const { isUnread, markSeen } = useChannelSeen(list)

  // Viewing a channel is reading it: whenever its rail-known activity
  // advances, the marker follows (markSeen no-ops while covered).
  useEffect(() => {
    if (active) markSeen(active)
  }, [active, markSeen])

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <ChannelRail
        activeKey={active?.key ?? null}
        channels={list}
        isUnread={isUnread}
        onSelect={setActiveKey}
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
