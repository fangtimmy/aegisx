import { useMutation } from "@tanstack/react-query"
import {
  Brain,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Send,
  Wrench,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { AgentSummary, RunPublic } from "@/api"
import { runsApi } from "@/api"
import { Markdown } from "@/components/markdown"
import { Badge } from "@/components/ui/badge"
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
import { Textarea } from "@/components/ui/textarea"
import {
  type ConversationItem,
  isRecord,
  type ToolBlock,
  toolStatusLabel,
} from "@/domain/conversation"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"

export function Conversation({
  runId,
  run,
  agents,
}: {
  runId: string
  run: RunPublic
  agents: AgentSummary[]
}) {
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
  const running = run.status === "running"

  const loadMessages = useCallback(async () => {
    try {
      const list = await runsApi.listMessages(runId, 0)
      const byAgent = new Map<string, typeof list.items>()
      for (const message of list.items) {
        const bucket = byAgent.get(message.agentId) ?? []
        bucket.push(message)
        byAgent.set(message.agentId, bucket)
      }
      for (const [agentId, messages] of byAgent) {
        store.applySnapshot(agentId, messages)
      }
    } catch {
      // non-fatal; live stream + retry reconcile on reconnect
    }
  }, [runId, store])

  useEffect(() => {
    const disconnect = store.connect(runId, loadMessages, setDisconnected)
    void loadMessages()
    return disconnect
  }, [runId, store, loadMessages])

  // Re-fetch when the agent list grows (e.g. a child spawned) so its history
  // is loaded even if committed SSE events raced ahead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional refetch on agent growth
  useEffect(() => {
    void loadMessages()
  }, [agents.length, loadMessages])

  const steer = useMutation({
    mutationFn: () =>
      runsApi.steerRun(runId, { text: draft.trim(), deliverAs }),
    onSuccess: () => setDraft(""),
    onError: (error) => toast.error("Failed to send message", error.message),
  })

  const effectiveAgentId = selectedAgentId || mainAgent?.id || ""
  const items = useSyncExternalStore(
    (cb) => store.subscribe(effectiveAgentId, cb),
    () => store.get(effectiveAgentId)
  )
  const activity = useSyncExternalStore(
    (cb) => store.subscribe(effectiveAgentId, cb),
    () => store.getActivity(effectiveAgentId)
  )

  const onSubmit = () => {
    if (!draft.trim() || !running) return
    steer.mutate()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {agents.length > 1 && (
        <AgentTabs
          agents={agents}
          selectedId={effectiveAgentId}
          onSelect={setSelectedAgentId}
        />
      )}
      <div className="min-h-0 flex-1">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Waiting for the agent</EmptyTitle>
                <EmptyDescription>
                  {running
                    ? "The agent is starting up. Messages will appear here as it works."
                    : "This run is not active."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <Timeline items={items} activity={activity} />
        )}
      </div>
      {disconnected && running && (
        <div className="flex items-center gap-2 border-t px-4 py-2 text-muted-foreground text-xs">
          <LoaderCircle className="size-3 animate-spin" /> Reconnecting…
        </div>
      )}
      {running && (
        <MessageInput
          busy={steer.isPending}
          deliverAs={deliverAs}
          draft={draft}
          onDeliverAsChange={setDeliverAs}
          onDraftChange={setDraft}
          onSubmit={onSubmit}
        />
      )}
    </div>
  )
}

function AgentTabs({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentSummary[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5">
      {agents.map((agent) => (
        <button
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            agent.id === selectedId
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
          key={agent.id}
          onClick={() => onSelect(agent.id)}
          type="button"
        >
          {agent.role === "main" ? "Main" : (agent.name ?? "Child")}
          {agent.status === "running" && (
            <span className="ml-1.5 inline-block size-1.5 rounded-full bg-info align-middle" />
          )}
        </button>
      ))}
    </div>
  )
}

function Timeline({
  items,
  activity,
}: {
  items: ConversationItem[]
  activity: { activity: "retrying" | "compacting"; detail?: string } | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
  })

  return (
    <div
      className="h-full overflow-auto"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      ref={ref}
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        {items.map((item) => (
          <ConversationRow item={item} key={item.key} />
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <LoaderCircle className="size-3 animate-spin" />
            {activity.activity === "compacting"
              ? "Compacting context…"
              : "Retrying…"}
            {activity.detail ? ` ${activity.detail}` : ""}
          </div>
        )}
      </div>
    </div>
  )
}

function ConversationRow({ item }: { item: ConversationItem }) {
  if (item.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {item.body}
        </div>
      </div>
    )
  }
  if (item.type === "handoff") {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm">
        <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
          <Wrench className="size-3" />
          {item.agentName ?? "Child agent"} · {item.status}
        </div>
        <div className="whitespace-pre-wrap">{item.body}</div>
      </div>
    )
  }
  return (
    <div className="max-w-[92%]">
      {item.blocks.map((block) => (
        <BlockView block={block} key={block.key} />
      ))}
    </div>
  )
}

type AgentBlock = Extract<ConversationItem, { type: "agent" }>["blocks"][number]

function BlockView({ block }: { block: AgentBlock }) {
  if (block.type === "text") {
    return (
      <div className="text-sm">
        <Markdown isAnimating>{block.body}</Markdown>
      </div>
    )
  }
  if (block.type === "reasoning") {
    return <ReasoningBlock body={block.body} />
  }
  if (block.type === "error") {
    return (
      <div className="my-1 flex items-start gap-1.5 text-destructive-foreground text-xs">
        <CircleAlert className="mt-0.5 size-3 shrink-0" />
        <span className="whitespace-pre-wrap">{block.body}</span>
      </div>
    )
  }
  return <ToolBlockView block={block as ToolBlock} />
}

function ReasoningBlock({ body }: { body: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
        type="button"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        <Brain className="size-3" />
        {open ? "Hide thinking" : "Show thinking"}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1 border-l-2 pl-3 text-muted-foreground text-xs whitespace-pre-wrap">
          {body}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

function ToolBlockView({ block }: { block: ToolBlock }) {
  const running = block.status === "running" || block.status === "pending"
  const [open, setOpen] = useState(running)
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="mt-1 flex w-full items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-left text-xs hover:bg-muted"
        type="button"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        <Wrench className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {toolStatusLabel(block.name, block.args, running)}
        </span>
        {block.status === "error" ? (
          <Badge size="sm" variant="error">
            error
          </Badge>
        ) : running ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Badge size="sm" variant="secondary">
            done
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ToolOutput block={block} />
      </CollapsiblePanel>
    </Collapsible>
  )
}

function ToolOutput({ block }: { block: ToolBlock }) {
  const value = block.output || (block.args ? formatArgs(block.args) : "")
  if (!value) {
    return (
      <pre className="px-2 py-1 font-mono text-muted-foreground text-xs">
        {block.status === "running" || block.status === "pending"
          ? "(running…)"
          : "(no output)"}
      </pre>
    )
  }
  const truncated =
    value.length > 64_000
      ? `${value.slice(0, 64_000)}\n\n[Output preview truncated]`
      : value
  return (
    <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs leading-5">
      {truncated}
    </pre>
  )
}

function formatArgs(args: unknown): string {
  if (!isRecord(args)) return ""
  const entries = Object.entries(args)
  if (entries.length === 0) return ""
  return entries
    .map(([key, value]) => {
      const text =
        typeof value === "string"
          ? value
          : value === null
            ? "null"
            : (JSON.stringify(value, null, 2) ?? String(value))
      return `${key}: ${text}`
    })
    .join("\n")
}

function MessageInput({
  draft,
  deliverAs,
  busy,
  onDraftChange,
  onDeliverAsChange,
  onSubmit,
}: {
  draft: string
  deliverAs: "steer" | "followUp"
  busy: boolean
  onDraftChange: (value: string) => void
  onDeliverAsChange: (value: "steer" | "followUp") => void
  onSubmit: () => void
}) {
  return (
    <div className="border-t p-3">
      <div className="flex items-center gap-1 pb-1.5 text-xs">
        <span className="text-muted-foreground">Deliver as</span>
        <button
          className={cn(
            "rounded px-1.5 py-0.5",
            deliverAs === "steer"
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onDeliverAsChange("steer")}
          type="button"
        >
          Steer
        </button>
        <button
          className={cn(
            "rounded px-1.5 py-0.5",
            deliverAs === "followUp"
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onDeliverAsChange("followUp")}
          type="button"
        >
          Follow-up
        </button>
        <span className="ml-auto text-muted-foreground">
          Steer interrupts after current tools; follow-up waits until idle.
        </span>
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-[2.5rem] flex-1 resize-none"
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder="Message the agent…"
          rows={2}
          value={draft}
        />
        <Button
          disabled={!draft.trim() || busy}
          loading={busy}
          onClick={onSubmit}
          size="icon"
          type="button"
        >
          <Send />
        </Button>
      </div>
    </div>
  )
}
