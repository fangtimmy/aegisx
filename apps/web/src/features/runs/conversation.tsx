import { useMutation } from "@tanstack/react-query"
import { Bot, GitFork, LoaderCircle, Send } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AgentSummary, RunPublic } from "@/api"
import { runsApi } from "@/api"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { ConversationStore } from "@/stream/conversation-store"
import { AgentActivityBadge } from "./agent-activity-badge"
import { AgentStatusIcon } from "./agent-status-icon"
import { Timeline } from "./timeline"

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

  // Keep the selected agent valid as agents appear/disappear (e.g. a child
  // spawns or completes).
  const effectiveAgentId =
    agents.find((a) => a.id === selectedAgentId)?.id ?? mainAgent?.id ?? ""
  const selectedAgent = agents.find((a) => a.id === effectiveAgentId) ?? null

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

  const send = useMutation({
    mutationFn: () =>
      runsApi.sendMessage(runId, { text: draft.trim(), deliverAs }),
    onSuccess: () => setDraft(""),
    onError: (error) => toast.error("Failed to send message", error.message),
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
                  {agent.role === "main" ? "Main" : (agent.name ?? "Child")}
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
      {disconnected && running && (
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2 text-muted-foreground text-xs">
          <LoaderCircle className="size-3 animate-spin" /> Reconnecting…
        </div>
      )}
      {selectedAgent && (
        <div className="shrink-0 border-t bg-background/95 px-4 py-3">
          {running && (
            <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 pb-2">
              <AgentActivityBadge
                agentId={selectedAgent.id}
                agentStatus={selectedAgent.status}
                stream={store}
              />
            </div>
          )}
          <MessageInput
            busy={send.isPending}
            closed={run.status === "closed"}
            deliverAs={deliverAs}
            draft={draft}
            onDeliverAsChange={setDeliverAs}
            onDraftChange={setDraft}
            onSubmit={onSubmit}
            running={running}
          />
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
  running,
  onDraftChange,
  onDeliverAsChange,
  onSubmit,
}: {
  draft: string
  deliverAs: "steer" | "followUp"
  busy: boolean
  closed: boolean
  running: boolean
  onDraftChange: (value: string) => void
  onDeliverAsChange: (value: "steer" | "followUp") => void
  onSubmit: () => void
}) {
  const placeholder = closed
    ? "Send a message to reopen and continue (container will rebuild)"
    : running
      ? "Steer or follow up the agent…"
      : "Send a message to the agent…"
  return (
    <div className="mx-auto max-w-3xl">
      {running && (
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
      )}
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
          placeholder={placeholder}
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
