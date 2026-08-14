import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileText, RotateCcw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import {
  keys,
  orchestrationConfigApi,
  type OrchestrationConfig,
  type PromptTemplateRow,
  promptTemplatesApi,
  settingsApi,
  type ModelRef,
} from "@/api"
import { Badge } from "@/components/ui/badge"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/lib/toast"

import { ModelRefPicker } from "../runs/model-switcher"
import { PromptEditor, type PromptPreviewKind } from "./prompt-editor"

/** Human titles for known template keys; unknown keys fall back to the key. */
const TEMPLATE_META: Record<string, { title: string; description?: string }> = {
  mainSystem: {
    title: "主系统提示词",
    description:
      "solver agent 的系统提示词（classic/observer-solver/bootstrap 共享）。",
  },
  childSystem: {
    title: "子系统提示词",
    description: "spawn 子 agent 的系统提示词（capabilities 清零）。",
  },
  initial: {
    title: "初始提示词",
    description: "新建 run 的首轮引导消息；入队时 queue.prompt 覆盖它。",
  },
  orchestratorSystem: {
    title: "调度者系统提示词",
    description: "scheduler 编排 run 的调度者 agent。",
  },
  observerSystem: {
    title: "观察者系统提示词",
    description: "observer-solver 编排的监督 agent。",
  },
  bootstrapSystem: {
    title: "探测系统提示词",
    description: "bootstrap-solver 编排的探测 agent。",
  },
  trioSystem: {
    title: "对等求解系统提示词",
    description: "trio 编排的对等 solver agent。",
  },
}

/** Preview kinds exist for the four builtin templates only (server preview
 * contexts are challenge/orchestrator-scoped). */
const BUILTIN_PREVIEW_KIND: Record<string, PromptPreviewKind> = {
  mainSystem: "mainSystemPrompt",
  childSystem: "childSystemPrompt",
  initial: "initialPrompt",
  orchestratorSystem: "orchestratorSystemPrompt",
}

const rowKey = (plugin: string, key: string) => `${plugin}\u0000${key}`

/** Orchestrator-context templates (event + instruction vars); the scheduler's
 * `initial` override renders against the event context too. */
function isOrchestratorContext(plugin: string, key: string): boolean {
  return (
    key === "orchestratorSystem" ||
    (plugin === "scheduler" && key === "initial")
  )
}

/**
 * Settings-page「编排」panel (spec §3.6 + v9 slot models): one card per
 * orchestration plugin. Each card lists the plugin's declared agent slots with
 * a per-slot model ref picker (the slot's model injected at createAgent time),
 * plus a prompt-templates section whose keys open an editor dialog. Prompt
 * templates live in the prompt_templates store keyed by (plugin, key); a key a
 * plugin declares in its own `templates` is owned by that plugin id, otherwise
 * it falls back to the builtin store.
 */
export function OrchestrationSettings() {
  const queryClient = useQueryClient()
  const config = useQuery({
    queryKey: keys.orchestrationConfig.all,
    queryFn: () => orchestrationConfigApi.listOrchestrationConfig(),
  })
  const templates = useQuery({
    queryKey: keys.promptTemplates.all,
    queryFn: () => promptTemplatesApi.listTemplates(),
  })
  const settings = useQuery({
    queryKey: keys.settings.all,
    queryFn: () => settingsApi.getSettings(),
  })

  /** Default bodies: builtin from /api/settings meta; plugin-declared from the
   * orchestration's `templates`. Reset source per (plugin, key). */
  const defaultsByRow = useMemo(() => {
    const map = new Map<string, string>()
    const builtin = settings.data?.meta.promptTemplateDefaults
    if (builtin) {
      for (const [key, body] of Object.entries(builtin)) {
        map.set(rowKey("builtin", key), body)
      }
    }
    for (const plugin of config.data?.items ?? []) {
      for (const [key, body] of Object.entries(plugin.templates)) {
        map.set(rowKey(plugin.id, key), body)
      }
    }
    return map
  }, [settings.data, config.data])

  const patchSlots = useMutation({
    mutationFn: ({
      pluginId,
      slots,
    }: {
      pluginId: string
      slots: Record<string, ModelRef | null>
    }) => orchestrationConfigApi.updateSlotModels(pluginId, slots),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.orchestrationConfig.all }),
    onError: (error) => toast.error("保存编排设置失败", error.message),
  })

  if (config.isPending || templates.isPending || settings.isPending) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        正在加载编排设置…
      </div>
    )
  }
  const error = config.error ?? templates.error ?? settings.error
  if (error) {
    return (
      <CardFrame className="min-w-0">
        <CardPanel className="text-sm text-destructive">
          {error.message}
        </CardPanel>
      </CardFrame>
    )
  }

  const variables = settings.data!.meta
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {config.data!.items.map((plugin) => (
        <OrchestrationCard
          defaultsByRow={defaultsByRow}
          key={plugin.id}
          orchestratorVars={variables.orchestratorPromptVariables}
          patchPending={
            patchSlots.isPending && patchSlots.variables?.pluginId === plugin.id
          }
          plugin={plugin}
          promptVars={variables.promptVariables}
          onSlotChange={(slot, ref) =>
            patchSlots.mutate({ pluginId: plugin.id, slots: { [slot]: ref } })
          }
        />
      ))}
    </div>
  )
}

function OrchestrationCard({
  plugin,
  defaultsByRow,
  promptVars,
  orchestratorVars,
  patchPending,
  onSlotChange,
}: {
  plugin: OrchestrationConfig
  defaultsByRow: Map<string, string>
  promptVars: string[]
  orchestratorVars: string[]
  patchPending: boolean
  onSlotChange: (slot: string, ref: ModelRef | null) => void
}) {
  // A template key's owning store: the plugin's own declared templates, else
  // builtin (run.render resolves current-plugin → builtin → throw).
  const owningPlugin = (key: string) =>
    key in plugin.templates ? plugin.id : "builtin"
  const rowFor = (key: string) => rowKey(owningPlugin(key), key)

  return (
    <CardFrame className="min-w-0">
      <CardFrameHeader>
        <CardFrameTitle>
          <span className="flex items-center gap-2">
            {plugin.label}
            <Badge size="sm" variant="secondary">
              {plugin.scope === "event" ? "调度者" : "解题"}
            </Badge>
          </span>
        </CardFrameTitle>
        <CardFrameDescription>{plugin.description}</CardFrameDescription>
      </CardFrameHeader>
      <Card>
        <CardPanel className="flex flex-col gap-5">
          <section>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Agent 模型
            </h3>
            <div className="grid gap-2">
              {plugin.agents.map((agent) => (
                <div
                  className="flex items-center gap-3 rounded-lg border px-3 py-2"
                  key={agent.slot}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {agent.name}
                      {agent.entry && (
                        <Badge size="sm" variant="outline">
                          入口
                        </Badge>
                      )}
                    </div>
                    <code className="text-[11px] text-muted-foreground">
                      {agent.slot} · {agent.role}
                    </code>
                  </div>
                  <Field>
                    <span className="sr-only">
                      <FieldLabel>{agent.name} 模型</FieldLabel>
                    </span>
                    <ModelRefPicker
                      allowEmpty
                      disabled={patchPending}
                      onChange={(ref) => onSlotChange(agent.slot, ref)}
                      size="sm"
                      value={agent.model}
                    />
                  </Field>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              提示词模板
            </h3>
            <div className="divide-y overflow-hidden rounded-lg border">
              {plugin.templateKeys.map((key) => {
                const owner = owningPlugin(key)
                const meta = TEMPLATE_META[key] ?? { title: key }
                const defaultBody = defaultsByRow.get(rowFor(key)) ?? ""
                return (
                  <PromptTemplateRow
                    defaultBody={defaultBody}
                    description={meta.description}
                    kind={
                      owner === "builtin"
                        ? BUILTIN_PREVIEW_KIND[key]
                        : undefined
                    }
                    key={key}
                    orchestratorVars={orchestratorVars}
                    plugin={owner}
                    promptVars={promptVars}
                    templateKey={key}
                    title={meta.title}
                  />
                )
              })}
            </div>
          </section>
        </CardPanel>
      </Card>
    </CardFrame>
  )
}

/** One prompt-template row: title + modified marker + an edit button that opens
 * a dialog with the full {@link PromptEditor} (debounced save + reset). */
function PromptTemplateRow({
  plugin,
  templateKey,
  title,
  description,
  defaultBody,
  promptVars,
  orchestratorVars,
  kind,
}: {
  plugin: string
  templateKey: string
  title: string
  description?: string
  defaultBody: string
  promptVars: string[]
  orchestratorVars: string[]
  kind?: PromptPreviewKind
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const templates = useQuery({
    queryKey: keys.promptTemplates.all,
    queryFn: () => promptTemplatesApi.listTemplates(),
  })
  const row = useMemo(() => {
    const all = templates.data?.items ?? []
    return all.find((r) => r.plugin === plugin && r.key === templateKey)
  }, [templates.data, plugin, templateKey])
  const [value, setValue] = useState(row?.body ?? defaultBody)

  // Re-seed the local draft whenever the row/default it tracks changes and the
  // dialog is closed (avoids clobbering in-flight edits).
  const tracked = row?.body ?? defaultBody
  useEffect(() => {
    if (!open) setValue(tracked)
  }, [tracked, open])

  const save = useMutation({
    mutationFn: (body: string) =>
      promptTemplatesApi.updateTemplate({
        plugin,
        key: templateKey,
        body,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(keys.promptTemplates.all, response)
    },
    onError: (error) => toast.error("保存提示词模板失败", error.message),
  })

  const vars = isOrchestratorContext(plugin, templateKey)
    ? orchestratorVars
    : promptVars
  const modified = value !== defaultBody

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div
        aria-hidden
        className={`min-h-7 self-stretch rounded-e-sm ${modified ? "bg-primary" : "bg-transparent"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        <code className="text-[11px] text-muted-foreground">
          {plugin} / {templateKey}
        </code>
      </div>
      <Dialog onOpenChange={setOpen} open={open}>
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
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              留空即保存为空（不回退默认）。改动即时保存，对新任务生效。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <PromptEditor
              kind={kind}
              onChange={(next) => {
                setValue(next)
                save.mutate(next)
              }}
              title={title}
              value={value}
              variables={vars}
            />
            <div className="mt-2 flex items-center justify-between">
              <code className="text-[11px] text-muted-foreground">
                {plugin} / {templateKey}
              </code>
              {modified && (
                <Button
                  disabled={save.isPending}
                  onClick={() => {
                    setValue(defaultBody)
                    save.mutate(defaultBody)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" /> 重置为默认
                </Button>
              )}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
