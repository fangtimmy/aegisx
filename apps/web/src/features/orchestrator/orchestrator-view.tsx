import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  CircleAlert,
  FolderOpen,
  MessageSquare,
  Play,
  RotateCcw,
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
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Conversation } from "@/features/runs/conversation"
import { FilesWorkspace, type FilesApi } from "@/features/runs/files-workspace"
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

  const [view, setView] = useState<"conversation" | "files" | "instruction">(
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

  // Full model rows (with thinkingLevels + provider) for the start dialog's
  // reasoning picker, which filters levels to those the selected model supports.
  const availableModels = useMemo(
    () =>
      (providers.data?.items ?? []).flatMap((provider) =>
        provider.enabled && provider.apiKey
          ? provider.models
              .filter((model) => model.enabled)
              .map((model) => ({ ...model, provider }))
          : []
      ),
    [providers.data]
  )

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
  const newSessionMut = useMutation({
    mutationFn: () => orchestratorsApi.newOrchestratorSession(eventId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      })
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.messages(eventId),
      })
      toast.success("已开启新会话")
    },
    onError: (error: Error) => toast.error("开新会话失败", error.message),
  })

  // Optimistic local mirrors for the config knobs (model / reasoning). The
  // server values stay authoritative (resynced on refetch), but local state
  // lets the selects feel instant instead of waiting for the 4s poll.
  const [localModelId, setLocalModelId] = useState<string | null>(
    orch?.modelId ?? null
  )
  useEffect(() => {
    setLocalModelId(orch?.modelId ?? null)
  }, [orch?.modelId])

  const [localThinking, setLocalThinking] = useState<ThinkingLevel>(
    orch?.thinkingLevel ?? "off"
  )
  useEffect(() => {
    setLocalThinking(orch?.thinkingLevel ?? "off")
  }, [orch?.thinkingLevel])

  // Resolve the selected model's supported reasoning levels; fall back to the
  // full ordered list when no model is pinned (global default).
  const selectedModel = availableModels.find((m) => m.id === localModelId)
  const supportedThinkingLevels =
    selectedModel?.thinkingLevels ?? ALL_THINKING_LEVELS

  // Switching model atomically re-clamps reasoning to a level the new model
  // supports, so the patch never lands in an inconsistent state.
  const handleModelChange = (next: string | null) => {
    setLocalModelId(next)
    const model = availableModels.find((m) => m.id === next)
    const levels = model?.thinkingLevels ?? ALL_THINKING_LEVELS
    const body: OrchestratorConfigInput = { modelId: next }
    if (!levels.includes(localThinking)) {
      const fallback = levels[0] ?? "off"
      setLocalThinking(fallback)
      body.thinkingLevel = fallback
    }
    patch.mutate(body)
  }

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

  // Workspace file browser adapter — same component the solver run uses,
  // pointed at the orchestrator's per-event files API.
  const orchestratorFiles = useMemo<FilesApi>(
    () => ({
      key: (p) => keys.orchestrator.files(eventId, p),
      get: (p) => orchestratorsApi.getOrchestratorFile(eventId, p),
      downloadUrl: (p) =>
        `/api/events/${eventId}/orchestrator/files/download?path=${encodeURIComponent(p)}`,
    }),
    [eventId]
  )

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
            <StartOrchestratorDialog
              availableModels={availableModels}
              enabled={orch.enabled}
              eventId={eventId}
              thinkingLevel={orch.thinkingLevel}
              modelId={orch.modelId}
              providersItems={providers.data?.items ?? []}
            />
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
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button size="sm" type="button" variant="outline" />}
              >
                关闭
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>关闭编排器？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将释放编排器的会话与资源（warm →
                    closed），对话历史保留；之后可通过「启动」重新拉起。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button type="button" variant="ghost" />}
                  >
                    取消
                  </AlertDialogClose>
                  <Button
                    loading={closeMut.isPending}
                    onClick={() => closeMut.mutate()}
                    type="button"
                  >
                    关闭
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          )}
        </CardFrameAction>
      </CardFrameHeader>
      <Card className="min-h-0 flex-1">
        <CardPanel className="h-full min-h-0 p-0">
          <Tabs
            className="flex h-full min-h-0 min-w-0 flex-col"
            onValueChange={(value) =>
              setView(value as "conversation" | "files" | "instruction")
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
              <TabsTab className="gap-2" value="files">
                <FolderOpen /> 文件
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
            <TabsPanel className="min-h-0 flex-1 overflow-hidden" value="files">
              <FilesWorkspace
                enabled={view === "files"}
                files={orchestratorFiles}
                rootLabel="工作台文件"
              />
            </TabsPanel>
            <TabsPanel
              className="min-h-0 flex-1 overflow-hidden"
              value="instruction"
            >
              <ScrollArea className="h-full" scrollFade>
                <div className="mx-auto max-w-3xl space-y-4 p-6">
                  <Field>
                    <FieldLabel htmlFor="orchestrator-instruction">
                      指令
                    </FieldLabel>
                    <FieldDescription>
                      自然语言策略。编排器在调度和审查任务时会遵循此指令。
                    </FieldDescription>
                    <Textarea
                      id="orchestrator-instruction"
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="例如：先打低分题；pwn 放到最后；跳过已解决的题目。"
                      rows={6}
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
                  </Field>
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
                  <div className="space-y-4 rounded-md border p-3">
                    <Field>
                      <FieldLabel htmlFor="orch-model">模型</FieldLabel>
                      <Select
                        items={Object.fromEntries([
                          ["__default__", "（全局默认）"],
                          ...modelOptions.map((m) => [m.id, m.label]),
                        ])}
                        onValueChange={(value) => {
                          const next =
                            value === "__default__" ? null : (value as string)
                          handleModelChange(next)
                        }}
                        value={localModelId ?? "__default__"}
                      >
                        <SelectTrigger id="orch-model" size="sm">
                          <SelectValue placeholder="（全局默认）" />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="__default__">
                            （全局默认）
                          </SelectItem>
                          {modelOptions.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="orch-thinking">推理</FieldLabel>
                        <Select
                          items={Object.fromEntries(
                            supportedThinkingLevels.map((level) => [
                              level,
                              thinkingLevelLabels[level],
                            ])
                          )}
                          onValueChange={(value) => {
                            const next = value as ThinkingLevel
                            setLocalThinking(next)
                            patch.mutate({ thinkingLevel: next })
                          }}
                          value={localThinking}
                        >
                          <SelectTrigger id="orch-thinking" size="sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {supportedThinkingLevels.map((level) => (
                              <SelectItem key={level} value={level}>
                                {thinkingLevelLabels[level]}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="orch-targets">
                          最大并发目标数
                        </FieldLabel>
                        <NumberField
                          max={32}
                          min={0}
                          onValueChange={(value) => setMaxTargets(value ?? 0)}
                          step={1}
                          value={maxTargets}
                        >
                          <NumberFieldGroup>
                            <NumberFieldDecrement />
                            <NumberFieldInput
                              id="orch-targets"
                              onBlur={() => {
                                if (maxTargets !== orch.maxConcurrentTargets)
                                  patch.mutate({
                                    maxConcurrentTargets: maxTargets,
                                  })
                              }}
                            />
                            <NumberFieldIncrement />
                          </NumberFieldGroup>
                        </NumberField>
                      </Field>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">开新会话</p>
                      <p className="text-xs text-muted-foreground">
                        丢弃当前对话上下文，以空白会话重启。旧会话保留为历史，工作区文件不受影响。
                      </p>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            disabled={newSessionMut.isPending}
                            loading={newSessionMut.isPending}
                            size="sm"
                            type="button"
                            variant="destructive-outline"
                          />
                        }
                      >
                        <RotateCcw /> 开新会话
                      </AlertDialogTrigger>
                      <AlertDialogPopup>
                        <AlertDialogHeader>
                          <AlertDialogTitle>开启新会话？</AlertDialogTitle>
                          <AlertDialogDescription>
                            当前对话上下文将被清空，编排器以空白会话重启。旧会话记录会保留为历史，工作台文件（策略/状态笔记）不受影响。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose
                            render={<Button type="button" variant="ghost" />}
                          >
                            取消
                          </AlertDialogClose>
                          <Button
                            onClick={() => newSessionMut.mutate()}
                            type="button"
                            variant="destructive"
                          >
                            <RotateCcw /> 开新会话
                          </Button>
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
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

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
}
const offThinkingLevels: ThinkingLevel[] = ["off"]
const ALL_THINKING_LEVELS: ThinkingLevel[] = Object.keys(
  thinkingLevelLabels
) as ThinkingLevel[]

type StartModel = {
  id: string
  label: string
  thinkingLevels: ThinkingLevel[]
  provider: { id: string; label: string }
}

/** Pre-start dialog (model + thinking picker), mirroring the solver run's
 * create dialog. Patches the orchestrator config (arming `enabled` if needed)
 * then starts. */
function StartOrchestratorDialog({
  eventId,
  enabled,
  modelId,
  thinkingLevel,
  availableModels,
  providersItems,
}: {
  eventId: string
  enabled: boolean
  modelId: string | null
  thinkingLevel: ThinkingLevel
  availableModels: StartModel[]
  providersItems: { id: string; label: string }[]
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState(
    modelId ?? availableModels[0]?.id ?? ""
  )
  const [level, setLevel] = useState<ThinkingLevel>(thinkingLevel)
  useEffect(() => {
    setSelectedModelId(modelId ?? availableModels[0]?.id ?? "")
  }, [modelId, availableModels])
  useEffect(() => {
    setLevel(thinkingLevel)
  }, [thinkingLevel])

  const selected = availableModels.find((m) => m.id === selectedModelId)
  const supported = selected?.thinkingLevels ?? offThinkingLevels
  const supportedKey = supported.join(",")
  useEffect(() => {
    if (!supportedKey.split(",").includes(level))
      setLevel(supported[0] ?? "off")
  }, [supportedKey, supported, level])

  const start = useMutation({
    mutationFn: async () => {
      const patch: OrchestratorConfigInput = {
        modelId: selectedModelId || null,
        thinkingLevel: level,
      }
      if (!enabled) patch.enabled = true
      if (
        modelId === (selectedModelId || null) &&
        thinkingLevel === level &&
        enabled
      ) {
        // nothing to change — just start
      } else {
        await orchestratorsApi.patchOrchestrator(eventId, patch)
      }
      return orchestratorsApi.startOrchestrator(eventId)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: keys.orchestrator.detail(eventId),
      })
      setOpen(false)
    },
    onError: (error: Error) => toast.error("启动失败", error.message),
  })

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={<Button loading={start.isPending} size="sm" type="button" />}
      >
        <Play /> {enabled ? "启动" : "启用并启动"}
      </DialogTrigger>
      {open ? (
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>启动编排器</DialogTitle>
            <DialogDescription>
              选择模型与推理强度。启动后仍可在对话框底部随时切换。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            <Field>
              <FieldLabel>模型</FieldLabel>
              <Select
                items={Object.fromEntries(
                  availableModels.map((m) => [
                    m.id,
                    `${m.provider.label} / ${m.label}`,
                  ])
                )}
                onValueChange={(v) => setSelectedModelId(v as string)}
                value={selectedModelId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="没有已启用的模型" />
                </SelectTrigger>
                <SelectPopup>
                  {providersItems.map((provider) => {
                    const models = availableModels.filter(
                      (m) => m.provider.id === provider.id
                    )
                    if (models.length === 0) return null
                    return (
                      <SelectGroup key={provider.id}>
                        <SelectGroupLabel>{provider.label}</SelectGroupLabel>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )
                  })}
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>推理</FieldLabel>
              <Select
                items={Object.fromEntries(
                  supported.map((l) => [l, thinkingLevelLabels[l]])
                )}
                onValueChange={(v) => setLevel(v as ThinkingLevel)}
                value={level}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {supported.map((l) => (
                    <SelectItem key={l} value={l}>
                      {thinkingLevelLabels[l]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {start.error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{start.error.message}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              取消
            </DialogClose>
            <Button
              disabled={!selectedModelId || start.isPending}
              loading={start.isPending}
              onClick={() => start.mutate()}
              type="button"
            >
              <Play /> {enabled ? "启动" : "启用并启动"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  )
}
