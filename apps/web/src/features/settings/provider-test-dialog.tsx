import { CircleAlert, Send } from "lucide-react"
import { useRef, useState } from "react"

import type { ProviderConnection } from "@/api"
import { streamProviderTest, type ProviderTestUsage } from "@/api/providers"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

type TestMetrics = {
  ttftMs: number | null
  totalMs: number | null
  usage: ProviderTestUsage | null
}

function formatMs(ms: number) {
  return ms < 10_000
    ? `${Math.max(1, Math.round(ms))}ms`
    : `${(ms / 1000).toFixed(1)}s`
}

/** 测试对话 dialog: one bare user message (no system prompt / tools) against
 * the provider's SAVED config, streamed. Client-side timing (TTFT / total)
 * plus the server-forwarded token usage. */
export function ProviderTestDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: ProviderConnection
}) {
  const [modelId, setModelId] = useState(provider.models[0]?.modelId ?? "")
  const [prompt, setPrompt] = useState("hi")
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState("")
  const [metrics, setMetrics] = useState<TestMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The in-flight test stream; aborted when the dialog closes mid-run. */
  const abortRef = useRef<AbortController | null>(null)

  const speed =
    metrics?.usage && metrics.ttftMs !== null && metrics.totalMs !== null
      ? metrics.usage.output /
        Math.max(0.001, (metrics.totalMs - metrics.ttftMs) / 1000)
      : null

  async function run() {
    if (!modelId || !prompt.trim()) return
    setRunning(true)
    setOutput("")
    setMetrics(null)
    setError(null)
    const startedAt = performance.now()
    let ttft: number | null = null
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await streamProviderTest(
        provider.id,
        { modelId, prompt: prompt.trim() },
        (event) => {
          if (event.type === "delta") {
            if (ttft === null) {
              ttft = performance.now() - startedAt
              setMetrics({ ttftMs: ttft, totalMs: null, usage: null })
            }
            setOutput((prev) => prev + event.text)
          } else if (event.type === "done") {
            setMetrics({
              ttftMs: ttft,
              totalMs: performance.now() - startedAt,
              usage: event.usage ?? null,
            })
          } else {
            setError(event.message)
          }
        },
        controller.signal
      )
    } catch (cause) {
      // A user-initiated close aborts the stream — not an error to surface.
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "测试失败")
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setRunning(false)
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          abortRef.current?.abort()
          abortRef.current = null
        }
        onOpenChange(next)
      }}
      open={open}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>测试对话 — {provider.label}</DialogTitle>
          <DialogDescription>
            单条用户消息直连供应商（无系统提示词、无工具），使用已保存的配置。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-end gap-2">
            <Label className="grid flex-1 gap-1.5">
              模型
              <Select
                disabled={provider.models.length === 0}
                items={Object.fromEntries(
                  provider.models.map((model) => [model.modelId, model.label])
                )}
                onValueChange={(value) => value && setModelId(value)}
                value={modelId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectPopup>
                  {provider.models.map((model) => (
                    <SelectItem key={model.modelId} value={model.modelId}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>
            <Label className="grid flex-1 gap-1.5">
              初始提示词
              <Input
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="hi"
                value={prompt}
              />
            </Label>
            <Button
              disabled={!modelId || !prompt.trim() || running}
              loading={running}
              onClick={() => void run()}
              type="button"
            >
              <Send /> 发送
            </Button>
          </div>
          {provider.models.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              该供应商还没有模型，先在下方添加模型。
            </p>
          )}
          {(output || running || error) && (
            <div
              className={cn(
                "mt-3 overflow-auto rounded-md border bg-muted/30 p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap",
                "max-h-72 min-h-16"
              )}
            >
              {output || (
                <span className="text-muted-foreground">
                  {running ? "等待首个 token…" : ""}
                </span>
              )}
            </div>
          )}
          {metrics && (
            <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
              {metrics.ttftMs !== null && (
                <span>首字 {formatMs(metrics.ttftMs)}</span>
              )}
              {metrics.totalMs !== null && (
                <span>总耗时 {formatMs(metrics.totalMs)}</span>
              )}
              {speed !== null && Number.isFinite(speed) && (
                <span>{speed.toFixed(1)} tok/s</span>
              )}
              {metrics.usage && (
                <span>
                  ↑{metrics.usage.input + metrics.usage.cacheRead} ↓
                  {metrics.usage.output}
                </span>
              )}
            </p>
          )}
          {error && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              {error}
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
