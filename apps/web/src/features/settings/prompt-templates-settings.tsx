import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileText, RotateCcw } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  keys,
  type PromptTemplateRow,
  promptTemplatesApi,
  settingsApi,
} from "@/api"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@/components/ui/card"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/lib/toast"

import { PromptEditor, type PromptPreviewKind } from "./prompt-editor"

/** The builtin template keys (v9: the plugin namespace is gone).
 * Unknown keys returned by the server fall back to the raw key. */
const TEMPLATE_KEYS = [
  "mainSystem",
  "initial",
  "orchestratorSystem",
  "schedulerInitial",
  "channelDelivery",
  "schedulerDigest",
] as const

/** System→agent notice templates (orch-notices + agent lifecycle lines):
 * seeded into the same builtin namespace, so the settings page lists/edits
 * them alongside the prompts. Previewed through the server's shared `notice`
 * sample context. (The scheduler's wakes are engine-rendered decision-point
 * payloads — not user-editable rows.) */
const NOTICE_TEMPLATE_KEYS = [
  "noticeFlagAccepted",
  "noticeFlagExtra",
  "noticeFlagPartial",
  "noticeFlagPartialProgress",
  "noticeSolveCleanup",
  "noticeChallengeHalt",
  "noticeLaunchFailed",
  "noticeQueueState",
  "noticeEventStalled",
  "noticeSchedulerViolation",
  "noticeAgentStarted",
  "noticeAgentIdle",
  "noticeAgentFlagAccepted",
  "noticeAgentFinished",
  "noticeAgentTimedOut",
  "noticeAgentReopened",
] as const

const TEMPLATE_META: Record<string, { title: string; description: string }> = {
  mainSystem: {
    title: "主系统提示词",
    description: "所有 solver 共用的系统提示词。",
  },
  initial: {
    title: "初始提示词",
    description:
      "challenge run 的首轮引导消息；run 级 strategy 与 solver 专属提示词追加进 Strategy 段。",
  },
  orchestratorSystem: {
    title: "调度者系统提示词",
    description: "event 域调度者 agent 的系统提示词。",
  },
  schedulerInitial: {
    title: "调度者初始提示词",
    description: "调度者 run 启动时的首轮引导消息。",
  },
  channelDelivery: {
    title: "频道投递格式",
    description:
      "频道消息合并投递给 agent 时的文本格式：块头、每消息行、附件行与溢出折行。",
  },
  schedulerDigest: {
    title: "调度快照",
    description:
      "附加到调度者每个决策点载荷尾部的 fleet 状态摘要（槽位、队列、每题 agent 概况）。",
  },
  noticeFlagAccepted: {
    title: "通知 · 首次解出",
    description: "题目首次完全解出时发到团队频道的通知。",
  },
  noticeFlagExtra: {
    title: "通知 · 额外 flag",
    description: "已解出题目上再确认一个 flag 时的通知。",
  },
  noticeFlagPartial: {
    title: "通知 · 部分解出（团队）",
    description: "多 flag 题部分解出时发到团队频道的通知。",
  },
  noticeFlagPartialProgress: {
    title: "通知 · 部分解出（调度）",
    description: "同一部分解出事件在调度频道的进度行。",
  },
  noticeSolveCleanup: {
    title: "通知 · 解出清理",
    description: "解出后自动停止同题 agent、取消排队项的摘要。",
  },
  noticeChallengeHalt: {
    title: "通知 · 手动停止",
    description: "操作员手动停止题目时关闭 agent、取消排队项的摘要。",
  },
  noticeLaunchFailed: {
    title: "通知 · 启动失败（紧急）",
    description: "队列项永久启动失败时的紧急通知。",
  },
  noticeQueueState: {
    title: "通知 · 队列暂停/恢复",
    description: "队列暂停或恢复时发到调度频道的通知。",
  },
  noticeEventStalled: {
    title: "通知 · 赛事停滞（紧急）",
    description: "队列有待发项但无存活 solver 排水时的紧急通知。",
  },
  noticeAgentStarted: {
    title: "通知 · agent 启动",
    description: "agent 启动时发到调度频道的生命周期行。",
  },
  noticeAgentIdle: {
    title: "通知 · agent 空闲",
    description: "agent 回合落定（空闲/失败）后发到调度频道的生命周期行。",
  },
  noticeAgentFlagAccepted: {
    title: "通知 · flag 接受",
    description: "agent 提交的 flag 被接受时发到调度频道的生命周期行。",
  },
  noticeAgentFinished: {
    title: "通知 · agent 完成",
    description: "agent 完成任务时发到调度频道的生命周期行。",
  },
  noticeAgentTimedOut: {
    title: "通知 · agent 超时（紧急）",
    description: "agent 触发硬截止时发到调度频道的生命周期行（紧急唤醒）。",
  },
  noticeAgentReopened: {
    title: "通知 · agent 重开",
    description: "终态 agent 被重开时发到调度频道的生命周期行。",
  },
  noticeSchedulerViolation: {
    title: "通知 · 调度违约（紧急）",
    description: "调度者连续多个决策点未提交计划时引擎升级发出的紧急告警。",
  },
}

/** Preview kinds the server has a sample context for; schedulerInitial has
 * none, so its preview button stays hidden. */
const BUILTIN_PREVIEW_KIND: Record<string, PromptPreviewKind> = {
  mainSystem: "mainSystemPrompt",
  initial: "initialPrompt",
  orchestratorSystem: "orchestratorSystemPrompt",
  channelDelivery: "channelDeliveryPrompt",
  schedulerDigest: "schedulerDigestPrompt",
}

/** Templates rendered against the orchestrator (event) context. */
const ORCHESTRATOR_CONTEXT_KEYS = new Set([
  "orchestratorSystem",
  "schedulerInitial",
])

/** Templates rendered against the delivery/digest contexts (their own
 * variable lists from the settings meta). */
const CHANNEL_DELIVERY_KEYS = new Set(["channelDelivery"])
const SCHEDULER_DIGEST_KEYS = new Set(["schedulerDigest"])

/** Settings-page prompt-templates panel (flat builtin keys — no plugin
 * grouping): the run/scheduler prompts plus the system→scheduler notices.
 * Each row opens an editor dialog with debounced save + reset-to-default. */
export function PromptTemplatesSettings() {
  const templates = useQuery({
    queryKey: keys.promptTemplates.all,
    queryFn: () => promptTemplatesApi.listTemplates(),
  })
  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })

  if (templates.isPending || settings.isPending) {
    return (
      <CardFrame className="min-w-0">
        <CardPanel>
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            正在加载提示词模板…
          </output>
        </CardPanel>
      </CardFrame>
    )
  }
  const error = templates.error ?? settings.error
  if (error) {
    return (
      <CardFrame className="min-w-0">
        <CardPanel className="text-sm text-destructive">
          {error.message}
        </CardPanel>
      </CardFrame>
    )
  }

  const defaults = settings.data!.meta.promptTemplateDefaults
  const variables = settings.data!.meta
  const rows = templates.data!.items
  return (
    <CardFrame className="min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>提示词模板</CardFrameTitle>
        <CardFrameDescription>
          内置提示词模板；改动即时保存，对新任务生效。
        </CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="p-0">
          <div className="divide-y">
            {[...TEMPLATE_KEYS, ...NOTICE_TEMPLATE_KEYS].map((key) => {
              const row = rows.find(
                (candidate) =>
                  candidate.plugin === "builtin" && candidate.key === key
              )
              return (
                <PromptTemplateRow
                  defaultBody={defaults[key] ?? row?.body ?? ""}
                  key={key}
                  orchestratorVars={variables.orchestratorPromptVariables}
                  promptVars={variables.promptVariables}
                  deliveryVars={variables.deliveryPromptVariables}
                  digestVars={variables.schedulerDigestVariables}
                  noticeVars={variables.noticePromptVariables}
                  row={row}
                  templateKey={key}
                />
              )
            })}
          </div>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** One prompt-template row: title + modified marker + inline 恢复默认 + an
 * edit button that opens a dialog with the full {@link PromptEditor}
 * (debounced save). The reset writes the default body straight through the
 * save mutation — no dialog round-trip needed. */
function PromptTemplateRow({
  row,
  templateKey,
  defaultBody,
  promptVars,
  orchestratorVars,
  deliveryVars,
  digestVars,
  noticeVars,
}: {
  row: PromptTemplateRow | undefined
  templateKey: string
  defaultBody: string
  promptVars: string[]
  orchestratorVars: string[]
  deliveryVars: string[]
  digestVars: string[]
  noticeVars: string[]
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const meta = TEMPLATE_META[templateKey] ?? {
    title: templateKey,
    description: "",
  }
  const [value, setValue] = useState(row?.body ?? defaultBody)

  // Re-seed the local draft whenever the row/default it tracks changes and the
  // dialog is closed (avoids clobbering in-flight edits).
  const tracked = row?.body ?? defaultBody
  useEffect(() => {
    if (!open) setValue(tracked)
  }, [tracked, open])

  // Debounced save (~600ms) with a stale-response guard: only write the cache
  // back when the response still matches the newest input, so an out-of-order
  // older response cannot clobber a newer keystroke's pending save.
  const latestBody = useRef(row?.body ?? defaultBody)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const timer = saveTimer
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const save = useMutation({
    mutationFn: (body: string) =>
      promptTemplatesApi.updateTemplate({
        plugin: "builtin",
        key: templateKey,
        body,
      }),
    onSuccess: (response) => {
      const saved = response.items.find(
        (r) => r.plugin === "builtin" && r.key === templateKey
      )
      if (saved && saved.body === latestBody.current) {
        queryClient.setQueryData(keys.promptTemplates.all, response)
      }
    },
    onError: (error) => toast.error("保存提示词模板失败", error.message),
  })

  const requestSave = (body: string) => {
    latestBody.current = body
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      save.mutate(body)
    }, 600)
  }

  const vars = useMemo(() => {
    if (templateKey.startsWith("notice")) return noticeVars
    if (ORCHESTRATOR_CONTEXT_KEYS.has(templateKey)) return orchestratorVars
    if (CHANNEL_DELIVERY_KEYS.has(templateKey)) return deliveryVars
    if (SCHEDULER_DIGEST_KEYS.has(templateKey)) return digestVars
    return promptVars
  }, [
    templateKey,
    orchestratorVars,
    promptVars,
    deliveryVars,
    digestVars,
    noticeVars,
  ])
  const modified = row !== undefined && row.body !== defaultBody

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div
        aria-hidden
        className={`min-h-7 self-stretch rounded-e-sm ${modified ? "bg-primary" : "bg-transparent"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{meta.title}</div>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
        <code className="text-2xs text-muted-foreground">
          builtin / {templateKey}
        </code>
      </div>
      <Dialog onOpenChange={setOpen} open={open}>
        {modified && (
          <Button
            disabled={save.isPending}
            onClick={() => requestSave(defaultBody)}
            size="sm"
            title="恢复为内置默认模板"
            type="button"
            variant="ghost"
          >
            <RotateCcw className="size-3.5" /> 恢复默认
          </Button>
        )}
        <Button
          onClick={() => setOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <FileText /> 编辑
        </Button>
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{meta.title}</DialogTitle>
            <DialogDescription>
              留空即保存为空（不回退默认）。改动即时保存，对新任务生效。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <PromptEditor
              kind={
                templateKey.startsWith("notice")
                  ? "notice"
                  : BUILTIN_PREVIEW_KIND[templateKey]
              }
              onChange={(next) => {
                setValue(next)
                requestSave(next)
              }}
              title={meta.title}
              value={value}
              variables={vars}
            />
            <div className="mt-2">
              <code className="text-2xs text-muted-foreground">
                builtin / {templateKey}
              </code>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
