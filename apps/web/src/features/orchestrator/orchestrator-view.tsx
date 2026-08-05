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
import type { OrchestratorConfigInput, ThinkingLevel } from "@/api"
import { keys, orchestratorsApi, providersApi } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { ModelThinkingSwitcher } from "@/features/runs/model-switcher"
import { Timeline } from "@/features/runs/timeline"
import { toast } from "@/lib/toast"
import { ConversationStore } from "@/stream/conversation-store"

const AGENT_ID = "orchestrator"

function orchestratorStatusLabel(
  status: "running" | "idle" | "closed"
): string {
  if (status === "running") return "运行中"
  if (status === "idle") return "空闲"
  return "已关闭"
}

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
      toast.success("编排器配置已保存")
    },
    onError: (error: Error) => toast.error("保存失败", error.message),
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
    onError: (error: Error) => toast.error("启动失败", error.message),
  })
  const stopMut = useMutation({
    mutationFn: () => orchestratorsApi.stopOrchestrator(eventId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      }),
    onError: (error: Error) => toast.error("停止失败", error.message),
  })
  const closeMut = useMutation({
    mutationFn: () => orchestratorsApi.closeOrchestrator(eventId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      }),
    onError: (error: Error) => toast.error("关闭失败", error.message),
  })
  const send = useMutation({
    mutationFn: () =>
      orchestratorsApi.sendOrchestratorMessage(eventId, { text: draft.trim() }),
    onSuccess: () => setDraft(""),
    onError: (error: Error) => toast.error("发送失败", error.message),
  })
  const switchModel = useMutation({
    mutationFn: (input: { modelId: string; thinkingLevel: ThinkingLevel }) =>
      orchestratorsApi.switchOrchestratorModel(eventId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      }),
    onError: (error: Error) => toast.error("切换模型失败", error.message),
  })

  if (detail.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm"
        role="status"
      >
        <Spinner aria-hidden="true" /> 正在加载编排器…
      </div>
    )
  }
  if (detail.error) {
    return (
      <Alert className="m-4 w-auto" variant="error">
        <CircleAlert />
        <AlertTitle>无法加载编排器</AlertTitle>
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
            <Bot className="size-4" /> 编排器
            <Badge variant={statusVariant}>
              {orchestratorStatusLabel(orch.status)}
            </Badge>
          </span>
        </CardFrameTitle>
        <CardFrameDescription className="font-mono text-xs">
          并发 {status.running}/{status.maxConcurrentRuns} · 目标{" "}
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
              <Play /> {orch.enabled ? "启动" : "启用并启动"}
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
              <Square /> 停止
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
              关闭
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
                <MessageSquare /> 对话
              </TabsTab>
              <TabsTab className="gap-2" value="instruction">
                <SettingsIcon /> 指令
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
                    正在重新连接…
                  </div>
                )}
                <div className="shrink-0 px-3 pb-3">
                  <CardFrame className="mx-auto max-w-3xl">
                    <Card>
                      <CardPanel className="p-2">
                        <form
                          className="flex w-full items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault()
                            if (draft.trim()) send.mutate()
                          }}
                        >
                          <input
                            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                            disabled={
                              send.isPending || orch.status === "closed"
                            }
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={
                              orch.status === "closed"
                                ? "启动编排器以开始"
                                : running
                                  ? "引导编排器…"
                                  : "向编排器发送消息…"
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
                      </CardPanel>
                    </Card>
                    <CardFrameFooter className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                      <ModelThinkingSwitcher
                        findCurrentModelId={() => orch.modelId}
                        thinkingLevel={orch.thinkingLevel}
                        disabled={orch.status === "closed"}
                        streaming={running}
                        onSwitch={(input) => switchModel.mutate(input)}
                      />
                    </CardFrameFooter>
                  </CardFrame>
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
                      指令
                    </label>
                    <p className="mb-2 text-muted-foreground text-xs">
                      自然语言策略。编排器在调度和审查任务时会遵循此指令。
                    </p>
                    <textarea
                      className="min-h-48 w-full rounded-md border bg-background p-3 text-sm"
                      id="orchestrator-instruction"
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="例如：先打低分题；pwn 放到最后；跳过已解决的题目。"
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
                        保存指令
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="font-medium text-sm">启用</p>
                      <p className="text-muted-foreground text-xs">
                        开启后，编排器即处于待命状态，随时可启动。
                      </p>
                    </div>
                    <Button
                      onClick={() => patch.mutate({ enabled: !orch.enabled })}
                      type="button"
                      variant={orch.enabled ? "secondary" : "outline"}
                    >
                      {orch.enabled ? "已启用" : "已禁用"}
                    </Button>
                  </div>
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          className="mb-1 block text-muted-foreground text-xs"
                          htmlFor="orch-model"
                        >
                          模型
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
                          <option value="">（全局默认）</option>
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
                          最大并发目标数
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
                      推理：{orch.thinkingLevel}
                    </p>
                  </div>
                  {usage && (
                    <div className="rounded-md border p-3">
                      <p className="mb-2 font-medium text-sm">
                        Token 用量与费用
                      </p>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-muted-foreground text-xs sm:grid-cols-3">
                        <div>
                          <dt className="text-[10px] uppercase">输入</dt>
                          <dd>{usage.input.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">输出</dt>
                          <dd>{usage.output.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">缓存</dt>
                          <dd>
                            {usage.cacheRead.toLocaleString()} 读 /{" "}
                            {usage.cacheWrite.toLocaleString()} 写
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">轮次</dt>
                          <dd>{usage.turns}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase">费用</dt>
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
