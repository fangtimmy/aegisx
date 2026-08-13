import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, CircleAlert, Clock3, Play, RefreshCw, Square } from "lucide-react"

import type { RunPublic, RunStatus } from "@/api"
import { challengesApi, keys } from "@/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatTime } from "@/lib/format"
import { toast } from "@/lib/toast"

export function statusVariant(status: RunStatus) {
  if (status === "running") return "info" as const
  if (status === "idle") return "success" as const
  return "secondary" as const
}

export function runStatusLabel(status: RunStatus): string {
  if (status === "running") return "运行中"
  if (status === "idle") return "空闲"
  if (status === "closed") return "已关闭"
  return status
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function RunOverview({ run }: { run: RunPublic }) {
  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      <Alert>
        <Box />
        <AlertTitle>容器工具箱</AlertTitle>
        <AlertDescription>
          agent 在宿主机端以进程内方式运行；该容器是一个 Kali 工具箱。bash
          在其中运行，配备完整 CTF
          工具链，其工作区与你的宿主机文件工具共享。可在「对话」标签页中监控并干预它。
        </AlertDescription>
      </Alert>
      {run.targetSupported && <TargetPanel run={run} />}
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">状态</dt>
          <dd className="mt-1">
            <Badge variant={statusVariant(run.status)}>
              {runStatusLabel(run.status)}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">模型</dt>
          <dd className="mt-1 font-mono text-xs break-all">
            {run.provider} / {run.modelName}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">推理</dt>
          <dd className="mt-1 capitalize">{run.thinkingLevel}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">镜像</dt>
          <dd className="mt-1 font-mono text-xs break-all">
            {run.image || "不可用"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">资源</dt>
          <dd className="mt-1 font-mono text-xs">
            {run.cpus} CPU · {run.memoryMb}MB · {run.pidsLimit} PID
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">开始时间</dt>
          <dd className="mt-1">{formatTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">完成时间</dt>
          <dd className="mt-1">{formatTime(run.completedAt)}</dd>
        </div>
      </dl>
      {run.usage && (
        <section className="border-t pt-4">
          <h3 className="mb-2 text-sm font-medium">Token 用量与费用</h3>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">输入</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {formatTokens(run.usage.input)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">输出</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {formatTokens(run.usage.output)}
                {run.usage.reasoning > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    （{formatTokens(run.usage.reasoning)} 推理）
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">缓存</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {formatTokens(run.usage.cacheRead)} 读 /{" "}
                {formatTokens(run.usage.cacheWrite)} 写
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">轮次</dt>
              <dd className="mt-0.5 font-mono text-xs">{run.usage.turns}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">费用</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {formatCost(run.usage.cost)}
              </dd>
            </div>
          </dl>
        </section>
      )}
      {(run.summary || run.flags.length > 0) && (
        <section className="border-t pt-4">
          <h3 className="mb-2 text-sm font-medium">结果</h3>
          {run.summary && (
            <p className="text-sm leading-6 whitespace-pre-wrap">
              {run.summary}
            </p>
          )}
          {run.flags.length > 0 && (
            <ul className="mt-2 grid gap-1">
              {run.flags.map((flag) => (
                <li className="font-mono text-xs break-all" key={flag.id}>
                  {flag.flag}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {run.error && (
        <Alert variant="error">
          <CircleAlert />
          <AlertTitle>任务失败</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {run.error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function TargetPanel({ run }: { run: RunPublic }) {
  const queryClient = useQueryClient()
  if (!run.challengeId) return null
  const challengeId = run.challengeId
  const key = keys.challenges.target(challengeId)
  const target = useQuery({
    queryKey: key,
    queryFn: () => challengesApi.getTarget(challengeId),
  })
  const action = useMutation({
    mutationFn: (value: "start" | "extend" | "stop") =>
      challengesApi.targetAction(challengeId, value),
    onSuccess: (value, variables) => {
      queryClient.setQueryData(key, value)
      const verb =
        variables === "start"
          ? "已启动"
          : variables === "stop"
            ? "已停止"
            : "已延长"
      toast.success(`目标 ${verb}`)
    },
    onError: (error) => toast.error("目标操作失败", error.message),
  })
  const value = target.data
  const statusLabel =
    value?.status === "running"
      ? "运行中"
      : value?.status === "absent"
        ? "未启动"
        : (value?.status ?? "加载中")

  return (
    <section className="border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">题目目标</h3>
        <Badge variant={value?.status === "running" ? "success" : "secondary"}>
          {statusLabel}
        </Badge>
        <Button
          aria-label="刷新目标"
          loading={target.isFetching}
          onClick={() => target.refetch()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw />
        </Button>
        {value?.status === "absent" && (
          <Button
            loading={action.isPending}
            onClick={() => action.mutate("start")}
            type="button"
            variant="outline"
          >
            <Play /> 启动
          </Button>
        )}
        {value?.status === "running" && (
          <>
            <Button
              loading={action.isPending && action.variables === "extend"}
              onClick={() => action.mutate("extend")}
              type="button"
              variant="outline"
            >
              <Clock3 /> 延长
            </Button>
            <Button
              loading={action.isPending && action.variables === "stop"}
              onClick={() => action.mutate("stop")}
              type="button"
              variant="destructive-outline"
            >
              <Square /> 停止
            </Button>
          </>
        )}
      </div>
      {value && value.endpoints.length > 0 && (
        <div className="mt-3 grid gap-2">
          {value.endpoints.map((endpoint) => (
            <div
              className="flex min-w-0 items-center justify-between gap-3 text-sm"
              key={`${endpoint.name}:${endpoint.address}`}
            >
              <span className="text-muted-foreground">{endpoint.name}</span>
              <code className="truncate text-xs">{endpoint.address}</code>
            </div>
          ))}
        </div>
      )}
      {value?.expiresAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          过期时间 {formatTime(value.expiresAt)}
        </p>
      )}
      {(target.error || action.error) && (
        <p className="mt-2 text-xs text-destructive">
          {(target.error ?? action.error)?.message}
        </p>
      )}
    </section>
  )
}
