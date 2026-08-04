import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  CircleAlert,
  MessageSquare,
  Play,
  Send,
  Settings as SettingsIcon,
  Square,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OrchestratorConfigInput } from "@/api"
import { keys, orchestratorsApi, providersApi } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Timeline } from "@/features/runs/timeline"
import { toast } from "@/lib/toast"
import { ConversationStore } from "@/stream/conversation-store"

const AGENT_ID = "orchestrator"

export function OrchestratorView({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: keys.orchestrator.detail(eventId),
    queryFn: () => orchestratorsApi.getOrchestrator(eventId),
    // The conversation streams over SSE; this poll only refreshes the
    // concurrency/target status strip while the orchestrator is active.
    refetchInterval: (query) =>
      query.state.data?.orchestrator.status === "running" ? 4000 : false,
  })

  const storeRef = useRef<ConversationStore | null>(null)
  if (storeRef.current === null) storeRef.current = new ConversationStore()
  const store = storeRef.current
  const [disconnected, setDisconnected] = useState(false)
  const [draft, setDraft] = useState("")
  const [view, setView] = useState<"conversation" | "instruction">(
    "conversation"
  )

  const loadMessages = useCallback(async () => {
    try {
      const list = await orchestratorsApi.listOrchestratorMessages(eventId, 0)
      store.applySnapshot(AGENT_ID, list.items)
    } catch {
      // non-fatal; live stream reconciles
    }
  }, [eventId, store])

  useEffect(() => {
    const disconnect = store.connect(
      eventId,
      loadMessages,
      setDisconnected,
      `/api/events/${eventId}/orchestrator/stream`
    )
    void loadMessages()
    return disconnect
  }, [eventId, store, loadMessages])

  const orch = detail.data?.orchestrator
  const status = detail.data?.status
  const running = orch?.status === "running"

  const providers = useQuery({
    queryKey: keys.providers.all,
    queryFn: () => providersApi.listProviders(),
  })
  const modelOptions = useMemo(() => {
    const items = providers.data?.items ?? []
    const out: { id: string; label: string }[] = []
    for (const provider of items) {
      if (!provider.enabled) continue
      for (const model of provider.models) {
        if (model.enabled)
          out.push({
            id: model.id,
            label: `${provider.label} / ${model.label}`,
          })
      }
    }
    return out
  }, [providers.data])

  const [maxTargets, setMaxTargets] = useState(orch?.maxConcurrentTargets ?? 1)
  useEffect(() => {
    setMaxTargets(orch?.maxConcurrentTargets ?? 1)
  }, [orch?.maxConcurrentTargets])

  const usage = detail.data?.usage

  const [instruction, setInstruction] = useState("")
  useEffect(() => {
    setInstruction(orch?.instruction ?? "")
  }, [orch?.instruction])

  const patch = useMutation({
    mutationFn: (body: OrchestratorConfigInput) =>
      orchestratorsApi.patchOrchestrator(eventId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      })
      toast.success("Orchestrator config saved")
    },
    onError: (error: Error) => toast.error("Failed to save", error.message),
  })
  const startMut = useMutation({
    mutationFn: async () => {
      // `enabled` gates start server-side (docs §九). If the user toggled it
      // off (or never enabled), arm it first so the primary CTA always works.
      if (!orch?.enabled) {
        await orchestratorsApi.patchOrchestrator(eventId, { enabled: true })
      }
      return orchestratorsApi.startOrchestrator(eventId)
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      }),
    onError: (error: Error) => toast.error("Failed to start", error.message),
  })
  const stopMut = useMutation({
    mutationFn: () => orchestratorsApi.stopOrchestrator(eventId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      }),
    onError: (error: Error) => toast.error("Failed to stop", error.message),
  })
  const closeMut = useMutation({
    mutationFn: () => orchestratorsApi.closeOrchestrator(eventId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      }),
    onError: (error: Error) => toast.error("Failed to close", error.message),
  })
  const send = useMutation({
    mutationFn: () =>
      orchestratorsApi.sendOrchestratorMessage(eventId, { text: draft.trim() }),
    onSuccess: () => setDraft(""),
    onError: (error: Error) => toast.error("Failed to send", error.message),
  })

  if (detail.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" /> Loading orchestrator...
      </div>
    )
  }
  if (detail.error) {
    return (
      <Alert className="m-4 w-auto" variant="error">
        <CircleAlert />
        <AlertTitle>Unable to load orchestrator</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (!orch || !status) return null

  const statusVariant =
    orch.status === "running"
      ? "info"
      : orch.status === "idle"
        ? "success"
        : "secondary"

  return (
    <CardFrame className="h-full min-h-0 min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex items-center gap-2">
            <Bot className="size-4" /> Orchestrator
            <Badge variant={statusVariant}>{orch.status}</Badge>
          </span>
        </CardFrameTitle>
        <CardFrameDescription className="font-mono text-xs">
          Concurrency {status.running}/{status.maxConcurrentRuns} · Targets{" "}
          {status.inflightTargets}/{status.maxConcurrentTargets}
        </CardFrameDescription>
        <CardFrameAction className="gap-2">
          {orch.status === "closed" && (
            <Button
              loading={startMut.isPending}
              onClick={() => startMut.mutate()}
              size="sm"
              type="button"
            >
              <Play /> {orch.enabled ? "Start" : "Enable & Start"}
            </Button>
          )}
          {running && (
            <Button
              loading={stopMut.isPending}
              onClick={() => stopMut.mutate()}
              size="sm"
              type="button"
              variant="destructive-outline"
            >
              <Square /> Stop
            </Button>
          )}
          {orch.status !== "closed" && (
            <Button
              loading={closeMut.isPending}
              onClick={() => closeMut.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              Close
            </Button>
          )}
        </CardFrameAction>
      </CardFrameHeader>
      <Card className="min-h-0 flex-1">
        <CardPanel className="h-full min-h-0 p-0">
          <Tabs
            className="flex h-full min-h-0 min-w-0 flex-col"
            onValueChange={(value) =>
              setView(value as "conversation" | "instruction")
            }
            value={view}
          >
            <TabsList
              className="mx-6 w-auto shrink-0 justify-start border-b"
              variant="underline"
            >
              <TabsTab className="gap-2" value="conversation">
                <MessageSquare /> Conversation
              </TabsTab>
              <TabsTab className="gap-2" value="instruction">
                <SettingsIcon /> Instruction
              </TabsTab>
            </TabsList>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="conversation"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <ScrollArea className="relative h-full" scrollFade>
                    <Timeline agentId={AGENT_ID} stream={store} />
                  </ScrollArea>
                </div>
                {disconnected && running && (
                  <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2 text-muted-foreground text-xs">
                    Reconnecting…
                  </div>
                )}
                <div className="shrink-0 border-t p-3">
                  <form
                    className="mx-auto flex max-w-3xl items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (draft.trim()) send.mutate()
                    }}
                  >
                    <input
                      className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                      disabled={send.isPending || orch.status === "closed"}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={
                        orch.status === "closed"
                          ? "Start the orchestrator to begin"
                          : running
                            ? "Steer the orchestrator…"
                            : "Send a message to the orchestrator…"
                      }
                      value={draft}
                    />
                    <Button
                      disabled={
                        !draft.trim() ||
                        send.isPending ||
                        orch.status === "closed"
                      }
                      loading={send.isPending}
                      size="icon"
                      type="submit"
                    >
                      <Send />
                    </Button>
                  </form>
                </div>
              </div>
            </TabsPanel>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="instruction"
            >
              <ScrollArea className="h-full" scrollFade>
                <div className="mx-auto max-w-3xl space-y-4 p-6">
                  <div>
                    <label
                      className="mb-1 block font-medium text-sm"
                      htmlFor="orchestrator-instruction"
                    >
                      Instruction
                    </label>
                    <p className="mb-2 text-muted-foreground text-xs">
                      Natural-language strategy. The orchestrator follows this
                      when scheduling and reviewing runs.
                    </p>
                    <textarea
                      className="min-h-48 w-full rounded-md border bg-background p-3 text-sm"
                      id="orchestrator-instruction"
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="e.g. Hit low-point challenges first; leave pwn for last; skip already-solved ones."
                      value={instruction}
                    />
                    <div className="mt-2 flex justify-end">
                      <Button
                        disabled={
                          patch.isPending || instruction === orch.instruction
                        }
                        onClick={() => patch.mutate({ instruction })}
                        type="button"
                      >
                        Save instruction
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="font-medium text-sm">Enabled</p>
                      <p className="text-muted-foreground text-xs">
                        When on, the orchestrator is armed and ready to start.
                      </p>
                    </div>
                    <Button
                      onClick={() => patch.mutate({ enabled: !orch.enabled })}
                      type="button"
                      variant={orch.enabled ? "secondary" : "outline"}
                    >
                      {orch.enabled ? "Enabled" : "Disabled"}
                    </Button>
                  </div>
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          className="mb-1 block text-muted-foreground text-xs"
                          htmlFor="orch-model"
                        >
                          Model
                        </label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          disabled={patch.isPending}
                          id="orch-model"
                          onChange={(e) =>
                            patch.mutate({ modelId: e.target.value || null })
                          }
                          value={orch.modelId ?? ""}
                        >
                          <option value="">(global default)</option>
                          {modelOptions.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          className="mb-1 block text-muted-foreground text-xs"
                          htmlFor="orch-targets"
                        >
                          Max concurrent targets
                        </label>
                        <input
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          disabled={patch.isPending}
                          id="orch-targets"
                          max={32}
                          min={0}
                          onBlur={() => {
                            if (maxTargets !== orch.maxConcurrentTargets)
                              patch.mutate({
                                maxConcurrentTargets: maxTargets,
                              })
                          }}
                          onChange={(e) =>
                            setMaxTargets(Number(e.target.value))
                          }
                          type="number"
                          value={maxTargets}
                        />
                      </div>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Reasoning: {orch.thinkingLevel}
                    </p>
                  </div>
                  {usage && (
                    <div className="rounded-md border p-3">
                      <p className="mb-2 font-medium text-sm">
                        Token usage &amp; cost
                      </p>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-muted-foreground text-xs sm:grid-cols-3">
                        <div>
                          <dt className="text-[10px] uppercase">Input</dt>
                          <dd>{usage.input.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">Output</dt>
                          <dd>{usage.output.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">Cache</dt>
                          <dd>
                            {usage.cacheRead.toLocaleString()} R /{" "}
                            {usage.cacheWrite.toLocaleString()} W
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">Turns</dt>
                          <dd>{usage.turns}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">Cost</dt>
                          <dd>${usage.cost.toFixed(3)}</dd>
                        </div>
                      </dl>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsPanel>
          </Tabs>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}
