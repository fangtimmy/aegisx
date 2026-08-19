import { useMutation } from "@tanstack/react-query"
import { CircleAlert, LoaderCircle, Plus } from "lucide-react"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type {
  AgentDetail,
  AgentSessionSummary,
  AgentSummary,
  MessageListItem,
  ModelRef,
} from "@/api"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardPanel,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"

import { AgentActivityBadge } from "./agent-activity-badge"
import { ContextStatStrip } from "./context-stat"
import { MessageInput } from "./message-input"
import { ModelRefPicker } from "./model-switcher"
import { SteerQueue } from "./steer-queue"
import { Timeline } from "./timeline"

/**
 * Data + lifecycle adapter for {@link Conversation}. The per-event
 * orchestrator (orchestrator-view) and any agent-level consumer implement
 * this; Conversation itself is agent-agnostic. The callbacks should be stable
 * (useCallback) so the SSE connection effect does not reconnect on re-render.
 */
export type ConversationProps = {
  /** SSE endpoint path. */
  streamPath: string
  /** The agent for this conversation (single). */
  agent: AgentSummary
  /** Optional agent detail (system prompt + tool definitions) for the
   * timeline's config panel. Hosts that fetch AgentDetail pass it here. */
  detail?: AgentDetail
  /** Aggregate status driving the input placeholder + switcher disabled state. */
  status: "running" | "idle" | "closed"
  /** Whether messaging a terminal agent reopens it (solver agents reopen).
   * When false (orchestrator), the composer is locked while closed and the
   * user must (re)start it via the header action. */
  closedReopenable: boolean
  /** Offer steer/followUp queue editing. */
  canEditQueue: boolean
  /** Load durable committed messages (raw list; Conversation buckets by agent). */
  loadMessages: () => Promise<MessageListItem[]>
  /** Send a message to the agent (steer / followUp / new turn). */
  sendMessage: (
    text: string,
    deliverAs?: "steer" | "followUp"
  ) => Promise<unknown>
  /** Switch the agent's live model. */
  switchModel: (ref: ModelRef) => Promise<unknown>
  /** Replace the agent's steer/followUp queue. */
  setQueue: (
    agentId: string,
    body: { steering: string[]; followUp: string[] }
  ) => Promise<unknown>
  /** Manually compact the agent's context (composer /compact command). */
  compactAgent?: () => Promise<unknown>
  /** Abort the agent's current turn (composer stop button). */
  stopAgent?: () => Promise<unknown>
  /** Close the agent (composer /close command). */
  closeAgent?: () => Promise<unknown>
  /** Multi-session + flat-backtrack ops (v12). Optional — the composer /new,
   * the session bar, and the timeline backtrack affordance render only when
   * present. */
  sessionOps?: SessionOps
}

/** Per-agent session + backtrack ops (v12). */
type SessionOps = {
  listSessions: () => Promise<AgentSessionSummary[]>
  createSession: () => Promise<unknown>
  activateSession: (sessionId: string) => Promise<unknown>
  backtrack: (seq: number) => Promise<unknown>
}

export function Conversation(props: ConversationProps) {
  const {
    streamPath,
    agent,
    detail,
    status,
    canEditQueue,
    loadMessages: loadMessagesFn,
    sendMessage: sendMessageFn,
    switchModel: switchModelFn,
    setQueue,
    compactAgent: compactAgentFn,
    sessionOps,
  } = props

  const storeRef = useRef<ConversationStore | null>(null)
  if (storeRef.current === null) storeRef.current = new ConversationStore()
  const store = storeRef.current

  const agentId = agent.id
  const [disconnected, setDisconnected] = useState(false)
  const [draft, setDraft] = useState("")
  const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("steer")
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The agent's sessions (null until first fetch); used for the session bar. */
  const [sessions, setSessions] = useState<AgentSessionSummary[] | null>(null)
  /** seq of the committed row a flat backtrack targets (confirm dialog). */
  const [backtrackTarget, setBacktrackTarget] = useState<number | null>(null)
  const running = status === "running"
  const closed = status === "closed"
  const locked = closed && !props.closedReopenable

  // The steer/followUp picker is only meaningful mid-turn; once the turn
  // settles (idle/closed) the next send starts a fresh turn, so drop a stale
  // choice instead of silently carrying it into the next prompt.
  useEffect(() => {
    if (!running) setDeliverAs("steer")
  }, [running])

  // Fetch the agent's session list; re-run after a session mutation.
  const loadSessions = useCallback(async () => {
    if (!sessionOps) return
    try {
      setSessions(await sessionOps.listSessions())
    } catch {
      // keep the previous list; the next reload retries
    }
  }, [sessionOps])

  useEffect(() => {
    if (sessionOps) void loadSessions()
  }, [sessionOps, loadSessions])

  // Optimistic model-ref echo for the live switcher: echo the user's pick
  // immediately and reset when the agent (or its server-confirmed snapshot)
  // changes — on success the snapshot update clears the draft so the select
  // reflects the persisted ref.
  const [modelDraft, setModelDraft] = useState<ModelRef | null>(null)
  useEffect(() => {
    setModelDraft(null)
  }, [agent.id, agent.model])

  const queuedMessages = useSyncExternalStore(
    useCallback(
      (listener) => store.subscribe(agentId, listener),
      [store, agentId]
    ),
    useCallback(() => store.getQueue(agentId), [store, agentId]),
    useCallback(() => store.getQueue(agentId), [store, agentId])
  )
  const showSteerQueue =
    running &&
    canEditQueue &&
    queuedMessages !== null &&
    (queuedMessages.steering.length > 0 || queuedMessages.followUp.length > 0)

  const loadMessages = useCallback(async () => {
    try {
      const items = await loadMessagesFn()
      setLoadError(null)
      store.applySnapshot(agentId, items)
    } catch (error) {
      // Surface the failure (e.g. agent deleted / unreachable) instead of a
      // silent empty timeline; a later reconnect retry that succeeds clears it.
      setLoadError(error instanceof Error ? error.message : "加载消息失败")
    }
  }, [store, loadMessagesFn, agentId])

  useEffect(() => {
    const disconnect = store.connect(
      agentId,
      loadMessages,
      setDisconnected,
      streamPath
    )
    void loadMessages()
    return disconnect
  }, [agentId, streamPath, store, loadMessages])

  const send = useMutation({
    mutationFn: () => sendMessageFn(draft.trim(), deliverAs),
    onSuccess: () => setDraft(""),
    onError: (error) => toast.error("发送消息失败", error.message),
  })

  const switchModel = useMutation({
    mutationFn: (ref: ModelRef) => switchModelFn(ref),
    onError: (error) => toast.error("切换模型失败", error.message),
  })

  const compact = useMutation({
    mutationFn: () => {
      if (!compactAgentFn) throw new Error("压缩功能不可用")
      return compactAgentFn()
    },
    onSuccess: () => {
      setDraft("")
      toast.success("上下文已压缩")
    },
    onError: (error) => toast.error("压缩失败", error.message),
  })

  // Composer-driven agent controls: stop (send→stop swap, Esc-equivalent)
  // and close (/close command). Both are silent host callbacks; toasts live
  // here so the header stays identity-only.
  const stop = useMutation({
    mutationFn: () => {
      if (!props.stopAgent) throw new Error("停止功能不可用")
      return props.stopAgent()
    },
    onSuccess: () => toast.success("已停止当前轮"),
    onError: (error) => toast.error("停止失败", error.message),
  })

  const close = useMutation({
    mutationFn: () => {
      if (!props.closeAgent) throw new Error("关闭功能不可用")
      return props.closeAgent()
    },
    onSuccess: () => {
      setDraft("")
      toast.success("任务已关闭")
    },
    onError: (error) => toast.error("关闭失败", error.message),
  })

  // --- multi-session + flat backtrack (v12) --------------------------------
  // All three reset the store for the agent and reload committed messages:
  // the store's committed map is append-only, so a truncated session (or a
  // switched session) would keep stale rows without the reset.
  const newSession = useMutation({
    mutationFn: () => {
      if (!sessionOps) throw new Error("新会话功能不可用")
      return sessionOps.createSession()
    },
    onSuccess: async () => {
      setDraft("")
      toast.success("已创建新会话")
      store.reset(agentId)
      await loadMessages()
      void loadSessions()
    },
    onError: (error) => toast.error("新建会话失败", error.message),
  })

  const activate = useMutation({
    mutationFn: (sessionId: string) => {
      if (!sessionOps) throw new Error("会话切换不可用")
      return sessionOps.activateSession(sessionId)
    },
    onSuccess: async () => {
      store.reset(agentId)
      await loadMessages()
      void loadSessions()
    },
    onError: (error) => toast.error("切换会话失败", error.message),
  })

  const backtrack = useMutation({
    mutationFn: (seq: number) => {
      if (!sessionOps) throw new Error("回溯不可用")
      return sessionOps.backtrack(seq)
    },
    onSuccess: async () => {
      setBacktrackTarget(null)
      toast.success("已回溯")
      store.reset(agentId)
      await loadMessages()
      void loadSessions()
    },
    onError: (error) => {
      setBacktrackTarget(null)
      toast.error("回溯失败", error.message)
    },
  })

  const onSubmit = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    const command = trimmed.split(/\s+/)[0]?.toLowerCase()
    if (command === "/compact") {
      if (running) {
        toast.error("运行中无法压缩，请先停止")
        return
      }
      if (!compactAgentFn) {
        toast.error("压缩功能不可用")
        return
      }
      compact.mutate()
      return
    }
    if (command === "/new") {
      if (running) {
        toast.error("运行中无法新建会话，请先停止")
        return
      }
      if (!sessionOps) {
        toast.error("新会话功能不可用")
        return
      }
      newSession.mutate()
      return
    }
    if (command === "/close") {
      if (closed) {
        toast.error("任务已关闭，无需再次关闭")
        return
      }
      close.mutate()
      return
    }
    send.mutate()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sessions && sessions.length > 0 && sessionOps && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-6 py-1.5">
          {sessions.map((session, index) => (
            <button
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                session.isActive && "bg-secondary font-medium text-foreground"
              )}
              disabled={running || activate.isPending}
              key={session.id}
              onClick={() => {
                if (!session.isActive) activate.mutate(session.id)
              }}
              title={
                session.isActive
                  ? "当前会话"
                  : `切换到该会话（${session.messageCount} 条消息）`
              }
              type="button"
            >
              会话 {index + 1}
              {session.messageCount > 0 && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {session.messageCount}
                </span>
              )}
            </button>
          ))}
          <Button
            aria-label="新建会话"
            disabled={running || newSession.isPending}
            onClick={() => newSession.mutate()}
            size="icon-sm"
            title="新建会话 (/new)"
            type="button"
            variant="ghost"
          >
            <Plus />
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ScrollArea className="relative h-full" scrollFade>
          <Timeline
            agent={detail}
            agentId={agentId}
            canBacktrack={Boolean(sessionOps) && !running}
            key={agentId}
            onBacktrack={setBacktrackTarget}
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
      <div className="shrink-0 px-3 pb-3">
        <CardFrame className="mx-auto max-w-3xl">
          {showSteerQueue && (
            <CardFrameHeader className="px-3 py-2">
              <SteerQueue
                setQueue={setQueue}
                stream={store}
                agentId={agentId}
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
                onStop={props.stopAgent ? () => stop.mutate() : undefined}
                onSubmit={onSubmit}
                running={running}
                stopping={stop.isPending}
              />
            </CardPanel>
          </Card>
          <CardFrameFooter className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
            <ModelRefPicker
              disabled={locked}
              onChange={(ref) => {
                if (!ref) return
                setModelDraft(ref)
                switchModel.mutate(ref)
              }}
              size="sm"
              value={modelDraft ?? agent.model ?? null}
            />
            {running && (
              <AgentActivityBadge
                agentId={agentId}
                agentStatus={agent.status}
                stream={store}
              />
            )}
            <ContextStatStrip agentId={agentId} stream={store} />
          </CardFrameFooter>
        </CardFrame>
      </div>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setBacktrackTarget(null)
        }}
        open={backtrackTarget !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>回溯到该消息？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除该消息之后的所有消息，且不可恢复。工作区文件不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </AlertDialogClose>
            <Button
              loading={backtrack.isPending}
              onClick={() => {
                if (backtrackTarget !== null) backtrack.mutate(backtrackTarget)
              }}
              type="button"
              variant="destructive"
            >
              删除并回溯
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  )
}
