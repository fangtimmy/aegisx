import { useMutation } from "@tanstack/react-query"
import {
  Bot,
  ChevronDown,
  CircleAlert,
  GitFork,
  LoaderCircle,
  Send,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type { AgentSummary, MessageListItem, ThinkingLevel } from "@/api"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardPanel,
} from "@/components/ui/card"
import { ButtonGroup, GroupSeparator } from "@/components/ui/group"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"

import { AgentActivityBadge } from "./agent-activity-badge"
import { AgentStatusIcon } from "./agent-status-icon"
import { type AvailableModel, ModelThinkingSwitcher } from "./model-switcher"
import { Timeline } from "./timeline"

/**
 * Data + lifecycle adapter for {@link Conversation}. Both the solver run
 * (run-workspace) and the per-event orchestrator (orchestrator-view) implement
 * this; Conversation itself is agent-agnostic. The callbacks should be stable
 * (useCallback) so the SSE connection effect does not reconnect on re-render.
 */
export type ConversationProps = {
  /** LiveBus topic id (run id / event id). */
  topic: string
  /** SSE endpoint path. */
  streamPath: string
  /** Agents in this conversation (≥1). Re-renders agent tabs; does NOT affect
   * the SSE connection. The orchestrator passes a single synthetic agent. */
  agents: AgentSummary[]
  /** Aggregate status driving the input placeholder + switcher disabled state. */
  status: "running" | "idle" | "closed"
  /** Whether messaging a closed entity reopens it (solver runs cold-restore).
   * When false (orchestrator), the composer is locked while closed and the
   * user must (re)start it via the header action. */
  closedReopenable: boolean
  /** Resolve the current model id (UUID) from the providers list, for the
   * model switcher. Only used for the main agent. */
  findCurrentModelId: (models: AvailableModel[]) => string | null | undefined
  thinkingLevel: ThinkingLevel
  /** Offer steer/followUp queue editing (run main agent only). */
  canEditQueue: boolean
  /** Load durable committed messages (raw list; Conversation buckets by agent). */
  loadMessages: () => Promise<MessageListItem[]>
  /** Send a message (steer / followUp / new turn). */
  sendMessage: (
    text: string,
    deliverAs?: "steer" | "followUp"
  ) => Promise<unknown>
  /** Switch the live model (main agent). Parent owns success invalidation. */
  switchModel: (input: {
    modelId: string
    thinkingLevel: ThinkingLevel
  }) => Promise<unknown>
  /** Replace an agent's steer/followUp queue (run main agent only). */
  setQueue?: (
    agentId: string,
    body: { steering: string[]; followUp: string[] }
  ) => Promise<unknown>
}

export function Conversation(props: ConversationProps) {
  const {
    topic,
    streamPath,
    agents,
    status,
    findCurrentModelId,
    thinkingLevel,
    canEditQueue,
    loadMessages: loadMessagesFn,
    sendMessage: sendMessageFn,
    switchModel: switchModelFn,
    setQueue,
  } = props

  const storeRef = useRef<ConversationStore | null>(null)
  if (storeRef.current === null) storeRef.current = new ConversationStore()
  const store = storeRef.current

  const mainAgent = useMemo(
    () => agents.find((a) => a.role === "main") ?? agents[0],
    [agents]
  )
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    mainAgent?.id ?? ""
  )
  const [disconnected, setDisconnected] = useState(false)
  const [draft, setDraft] = useState("")
  const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("steer")
  const [loadError, setLoadError] = useState<string | null>(null)
  const running = status === "running"
  const closed = status === "closed"
  const locked = closed && !props.closedReopenable

  // The steer/followUp picker is only meaningful mid-turn; once the turn
  // settles (idle/closed) the next send starts a fresh turn, so drop a stale
  // choice instead of silently carrying it into the next prompt.
  useEffect(() => {
    if (!running) setDeliverAs("steer")
  }, [running])

  // Keep the selected agent valid as agents appear/disappear (e.g. a child
  // spawns or completes).
  const effectiveAgentId =
    agents.find((a) => a.id === selectedAgentId)?.id ?? mainAgent?.id ?? ""
  const selectedAgent = agents.find((a) => a.id === effectiveAgentId) ?? null

  const queueAgentId = selectedAgent?.id ?? ""
  const queuedMessages = useSyncExternalStore(
    useCallback(
      (listener) => store.subscribe(queueAgentId, listener),
      [store, queueAgentId]
    ),
    useCallback(() => store.getQueue(queueAgentId), [store, queueAgentId]),
    useCallback(() => store.getQueue(queueAgentId), [store, queueAgentId])
  )
  const showSteerQueue =
    running &&
    selectedAgent?.role === "main" &&
    canEditQueue &&
    setQueue !== undefined &&
    queuedMessages !== null &&
    (queuedMessages.steering.length > 0 || queuedMessages.followUp.length > 0)

  const loadMessages = useCallback(async () => {
    try {
      const items = await loadMessagesFn()
      setLoadError(null)
      const byAgent = new Map<string, MessageListItem[]>()
      for (const message of items) {
        const bucket = byAgent.get(message.agentId) ?? []
        bucket.push(message)
        byAgent.set(message.agentId, bucket)
      }
      for (const [agentId, messages] of byAgent) {
        store.applySnapshot(agentId, messages)
      }
    } catch (error) {
      // Surface the failure (e.g. run deleted / unreachable) instead of a
      // silent empty timeline; a later reconnect retry that succeeds clears it.
      setLoadError(error instanceof Error ? error.message : "加载消息失败")
    }
  }, [store, loadMessagesFn])

  useEffect(() => {
    const disconnect = store.connect(
      topic,
      loadMessages,
      setDisconnected,
      streamPath
    )
    void loadMessages()
    return disconnect
  }, [topic, streamPath, store, loadMessages])

  // Re-fetch when the agent list grows (e.g. a child spawned) so its history
  // is loaded even if committed SSE events raced ahead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional refetch on agent growth
  useEffect(() => {
    void loadMessages()
  }, [agents.length, loadMessages])

  const send = useMutation({
    mutationFn: () => sendMessageFn(draft.trim(), deliverAs),
    onSuccess: () => setDraft(""),
    onError: (error) => toast.error("发送消息失败", error.message),
  })

  const switchModel = useMutation({
    mutationFn: (input: { modelId: string; thinkingLevel: ThinkingLevel }) =>
      switchModelFn(input),
    onError: (error) => toast.error("切换模型失败", error.message),
  })

  const onSubmit = () => {
    if (!draft.trim()) return
    send.mutate()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {agents.length > 1 && (
        <Tabs
          className="shrink-0"
          onValueChange={(value) => setSelectedAgentId(value)}
          value={effectiveAgentId}
        >
          <TabsList
            className="mx-6 my-1.5 max-w-full overflow-x-auto border-b"
            variant="underline"
          >
            {agents.map((agent) => (
              <TabsTab className="gap-1.5 px-2" key={agent.id} value={agent.id}>
                {agent.role === "main" ? (
                  <Bot aria-hidden="true" className="size-3.5" />
                ) : (
                  <GitFork aria-hidden="true" className="size-3.5" />
                )}
                <span className="max-w-40 truncate">
                  {agent.role === "main" ? "主" : (agent.name ?? "子")}
                </span>
                <AgentStatusIcon
                  className="[&_svg]:size-3.5"
                  status={agent.status}
                />
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
      )}
      <div className="min-h-0 flex-1">
        <ScrollArea className="relative h-full" scrollFade>
          <Timeline
            agentId={effectiveAgentId}
            key={effectiveAgentId}
            stream={store}
          />
        </ScrollArea>
      </div>
      {loadError && (
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2 text-xs text-destructive">
          <CircleAlert className="size-3 shrink-0" />
          <span className="min-w-0 truncate">无法加载对话：{loadError}</span>
        </div>
      )}
      {disconnected && (
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" /> 正在重新连接…
        </div>
      )}
      {selectedAgent && (
        <div className="shrink-0 px-3 pb-3">
          <CardFrame className="mx-auto max-w-3xl">
            {showSteerQueue && setQueue && (
              <CardFrameHeader className="px-3 py-2">
                <SteerQueue
                  agentId={selectedAgent.id}
                  setQueue={setQueue}
                  stream={store}
                />
              </CardFrameHeader>
            )}
            <Card>
              <CardPanel className="p-2">
                <MessageInput
                  busy={send.isPending}
                  closed={closed}
                  closedReopenable={props.closedReopenable}
                  deliverAs={deliverAs}
                  draft={draft}
                  onDeliverAsChange={setDeliverAs}
                  onDraftChange={setDraft}
                  onSubmit={onSubmit}
                  running={running}
                />
              </CardPanel>
            </Card>
            <CardFrameFooter className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              {selectedAgent.role === "main" && (
                <ModelThinkingSwitcher
                  findCurrentModelId={findCurrentModelId}
                  thinkingLevel={thinkingLevel}
                  disabled={locked}
                  onSwitch={(input) => switchModel.mutate(input)}
                />
              )}
              {running && (
                <AgentActivityBadge
                  agentId={selectedAgent.id}
                  agentStatus={selectedAgent.status}
                  stream={store}
                />
              )}
              <ContextStatStrip agentId={selectedAgent.id} stream={store} />
            </CardFrameFooter>
          </CardFrame>
        </div>
      )}
    </div>
  )
}

function MessageInput({
  draft,
  deliverAs,
  busy,
  closed,
  closedReopenable,
  running,
  onDraftChange,
  onDeliverAsChange,
  onSubmit,
}: {
  draft: string
  deliverAs: "steer" | "followUp"
  busy: boolean
  closed: boolean
  closedReopenable: boolean
  running: boolean
  onDraftChange: (value: string) => void
  onDeliverAsChange: (value: "steer" | "followUp") => void
  onSubmit: () => void
}) {
  const locked = closed && !closedReopenable
  const placeholder = locked
    ? "已关闭，请重新启动以开始"
    : closed
      ? "发送消息以重新打开并继续（容器将重建）"
      : running
        ? "引导或追问 agent…"
        : "向 agent 发送消息…"
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Input
        aria-label="向 agent 发送消息"
        className="flex-1"
        disabled={busy || locked}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={placeholder}
        unstyled
        value={draft}
      />
      <ButtonGroup>
        <Button
          aria-label="发送消息"
          disabled={!draft.trim() || busy || locked}
          loading={busy}
          size="icon"
          type="submit"
        >
          <Send />
        </Button>
        {running && (
          <>
            <GroupSeparator />
            <Menu>
              <MenuTrigger
                render={
                  <Button aria-label="投递方式" size="icon" variant="outline" />
                }
              >
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  onValueChange={(value) =>
                    onDeliverAsChange(value as "steer" | "followUp")
                  }
                  value={deliverAs}
                >
                  <MenuRadioItem value="steer">引导</MenuRadioItem>
                  <MenuRadioItem value="followUp">追问</MenuRadioItem>
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </>
        )}
      </ButtonGroup>
    </form>
  )
}

/** Format token counts for the stat strip, matching the pi-TUI footer rules. */
function formatStatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

/** Live per-agent context meter for the message box (pi-TUI footer parity):
 * ↑input ↓output RcacheRead WcacheWrite CH% $cost  percent%/window. */
function ContextStatStrip({
  agentId,
  stream,
  className,
}: {
  agentId: string
  stream: ConversationStore
  className?: string
}) {
  const subscribe = useCallback(
    (listener: () => void) => stream.subscribe(agentId, listener),
    [stream, agentId]
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    () => stream.getContext(agentId),
    () => stream.getContext(agentId)
  )
  if (!snapshot) return null
  const t = snapshot.totals
  const parts: Array<{ label: string; tone?: "warn" | "danger" }> = []
  if (t.input) parts.push({ label: `↑${formatStatTokens(t.input)}` })
  if (t.output) parts.push({ label: `↓${formatStatTokens(t.output)}` })
  if (t.cacheRead) parts.push({ label: `R${formatStatTokens(t.cacheRead)}` })
  if (t.cacheWrite) parts.push({ label: `W${formatStatTokens(t.cacheWrite)}` })
  if (snapshot.cacheHitRate !== null && (t.cacheRead > 0 || t.cacheWrite > 0))
    parts.push({ label: `CH${snapshot.cacheHitRate.toFixed(1)}%` })
  if (t.cost > 0) parts.push({ label: `$${t.cost.toFixed(3)}` })
  const percent = snapshot.percent
  const ctxTone =
    percent !== null && percent > 90
      ? "danger"
      : percent !== null && percent > 70
        ? "warn"
        : undefined
  parts.push({
    label:
      percent === null
        ? `?/${formatStatTokens(snapshot.contextWindow)}`
        : `${percent.toFixed(1)}%/${formatStatTokens(snapshot.contextWindow)}`,
    tone: ctxTone,
  })
  return (
    <span className={cn("font-mono text-muted-foreground", className)}>
      {parts.map((part) => (
        <span
          className={cn(
            "ml-2.5 first:ml-0",
            part.tone === "danger" && "text-destructive",
            part.tone === "warn" && "text-warning"
          )}
          key={part.label}
        >
          {part.label}
        </span>
      ))}
    </span>
  )
}

type QueueRow = { role: "steering" | "followUp"; index: number; text: string }

/** Editable list of queued steer / follow-up messages above the input. Commits
 * clear + re-queue via `setQueue`; the server reconciles through queue.updated. */
function SteerQueue({
  agentId,
  setQueue,
  stream,
}: {
  agentId: string
  setQueue: (
    agentId: string,
    body: { steering: string[]; followUp: string[] }
  ) => Promise<unknown>
  stream: ConversationStore
}) {
  const subscribe = useCallback(
    (listener: () => void) => stream.subscribe(agentId, listener),
    [stream, agentId]
  )
  const queue = useSyncExternalStore(
    subscribe,
    () => stream.getQueue(agentId),
    () => stream.getQueue(agentId)
  )
  const [edit, setEdit] = useState<QueueRow | null>(null)
  const put = useMutation({
    mutationFn: (body: { steering: string[]; followUp: string[] }) =>
      setQueue(agentId, body),
    onError: (error) => toast.error("更新队列失败", error.message),
  })

  const rows: QueueRow[] = [
    ...(queue?.steering ?? []).map((text, index) => ({
      role: "steering" as const,
      index,
      text,
    })),
    ...(queue?.followUp ?? []).map((text, index) => ({
      role: "followUp" as const,
      index,
      text,
    })),
  ]
  if (rows.length === 0) return null

  const replace = (
    role: "steering" | "followUp",
    index: number,
    text: string
  ) => {
    const base = {
      steering: [...(queue?.steering ?? [])],
      followUp: [...(queue?.followUp ?? [])],
    }
    base[role][index] = text
    put.mutate(base)
    setEdit(null)
  }
  const remove = (role: "steering" | "followUp", index: number) => {
    const base = {
      steering: [...(queue?.steering ?? [])],
      followUp: [...(queue?.followUp ?? [])],
    }
    base[role].splice(index, 1)
    put.mutate(base)
    setEdit(null)
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => {
        const editing = edit?.role === row.role && edit?.index === row.index
        return (
          <li
            className="flex items-center gap-1.5"
            key={`${row.role}:${row.index}`}
          >
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
                row.role === "steering"
                  ? "bg-info/15 text-info"
                  : "bg-secondary text-secondary-foreground"
              )}
            >
              {row.role === "steering" ? "引导" : "追问"}
            </span>
            {editing ? (
              <input
                className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
                onBlur={(e) => replace(row.role, row.index, e.target.value)}
                onChange={(e) => setEdit({ ...row, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    replace(row.role, row.index, edit.text)
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    setEdit(null)
                  }
                }}
                ref={(el) => el?.focus()}
                value={edit?.text ?? ""}
              />
            ) : (
              <button
                className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-secondary"
                onClick={() => setEdit(row)}
                title="点击编辑"
                type="button"
              >
                {row.text}
              </button>
            )}
            <Button
              aria-label="从队列移除"
              onClick={() => remove(row.role, row.index)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
