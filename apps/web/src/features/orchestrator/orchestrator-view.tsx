import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  CircleAlert,
  MessageSquare,
  Play,
  Settings as SettingsIcon,
  Square,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import type {
  AgentSummary,
  OrchestratorConfigInput,
  ThinkingLevel,
} from "@/api"
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
import { Conversation } from "@/features/runs/conversation"
import { toast } from "@/lib/toast"

/** Stable agent id for the orchestrator's single session (no `agents` row). */
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

  const [view, setView] = useState<"conversation" | "instruction">(
    "conversation"
  )

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
      // `enabled` gates start server-side. If the user toggled it off (or never
      // enabled), arm it first so the primary CTA always works.
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

  // --- Conversation adapter (same shape the solver run implements) ---------
  // The orchestrator is a single agent with no `agents` row, so we synthesize
  // one. canEditQueue is false: the orchestrator supports steer/followUp on
  // send, but exposes no queue-edit endpoint.
  const agents = useMemo<AgentSummary[]>(
    () =>
      orch
        ? [
            {
              id: AGENT_ID,
              runId: eventId,
              role: "main",
              parentAgentId: null,
              name: null,
              task: null,
              status: orch.status === "running" ? "running" : "idle",
              sessionFile: null,
              createdAt: orch.createdAt,
              startedAt: null,
              updatedAt: orch.updatedAt,
              completedAt: null,
              error: null,
            },
          ]
        : [],
    [orch, eventId]
  )
  const loadMessages = useCallback(
    () =>
      orchestratorsApi
        .listOrchestratorMessages(eventId, 0)
        .then((list) => list.items),
    [eventId]
  )
  const sendMessage = useCallback(
    (text: string, deliverAs?: "steer" | "followUp") =>
      orchestratorsApi.sendOrchestratorMessage(eventId, { text, deliverAs }),
    [eventId]
  )
  const switchModel = useCallback(
    (input: { modelId: string; thinkingLevel: ThinkingLevel }) =>
      orchestratorsApi.switchOrchestratorModel(eventId, input).then(() =>
        queryClient.invalidateQueries({
          queryKey: keys.orchestrator.detail(eventId),
        })
      ),
    [eventId, queryClient]
  )
  const findCurrentModelId = useCallback(() => orch?.modelId, [orch?.modelId])

  if (detail.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
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
              <Conversation
                agents={agents}
                canEditQueue={false}
                channel={eventId}
                closedReopenable={false}
                findCurrentModelId={findCurrentModelId}
                loadMessages={loadMessages}
                sendMessage={sendMessage}
                status={orch.status}
                streamPath={`/api/events/${eventId}/orchestrator/stream`}
                switchModel={switchModel}
                thinkingLevel={orch.thinkingLevel}
              />
            </TabsPanel>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="instruction"
            >
              <ScrollArea className="h-full" scrollFade>
                <div className="mx-auto max-w-3xl space-y-4 p-6">
                  <div>
                    <label
                      className="mb-1 block text-sm font-medium"
                      htmlFor="orchestrator-instruction"
                    >
                      指令
                    </label>
                    <p className="mb-2 text-xs text-muted-foreground">
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
                      <p className="text-sm font-medium">启用</p>
                      <p className="text-xs text-muted-foreground">
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
                          className="mb-1 block text-xs text-muted-foreground"
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
                          className="mb-1 block text-xs text-muted-foreground"
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
                    <p className="text-xs text-muted-foreground">
                      推理：{orch.thinkingLevel}
                    </p>
                  </div>
                  {usage && (
                    <div className="rounded-md border p-3">
                      <p className="mb-2 text-sm font-medium">
                        Token 用量与费用
                      </p>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground sm:grid-cols-3">
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
