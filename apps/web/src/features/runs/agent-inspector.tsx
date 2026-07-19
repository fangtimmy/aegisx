import { useQuery } from "@tanstack/react-query"
import { Info } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import type { AgentInspector, AgentSummary } from "@/lib/api"
import { apiRequest } from "@/lib/api"
import { statusVariant } from "./run-overview"
import { formatTime } from "./timeline"

export function AgentInspectorButton({
  agent,
  runId,
}: {
  agent: AgentSummary
  runId: string
}) {
  const [open, setOpen] = useState(false)
  const inspector = useQuery({
    enabled: open,
    queryKey: ["runs", runId, "agents", agent.id, "inspector"],
    queryFn: () =>
      apiRequest<AgentInspector>(`/runs/${runId}/agents/${agent.id}/inspector`),
  })

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label={`Inspect ${agent.name}`}
            size="icon-sm"
            title={`Inspect ${agent.name}`}
            variant="ghost"
          />
        }
      >
        <Info />
      </DialogTrigger>
      <DialogPopup className="h-[min(48rem,calc(100vh-2rem))] max-w-4xl">
        <DialogHeader>
          <DialogTitle>{agent.name}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <span>
              {agent.parentAgentId === null ? "Main agent" : "Child agent"}
            </span>
            <Badge variant={statusVariant(agent.status)}>{agent.status}</Badge>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-h-0 px-6 pb-6">
          {inspector.isPending ? (
            <div
              className="flex items-center gap-2 py-8 text-muted-foreground text-sm"
              role="status"
            >
              <Spinner aria-hidden="true" />
              Loading agent runtime...
            </div>
          ) : inspector.error ? (
            <p className="py-8 text-destructive text-sm">
              {inspector.error.message}
            </p>
          ) : inspector.data ? (
            <InspectorContent inspector={inspector.data} />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function InspectorContent({ inspector }: { inspector: AgentInspector }) {
  return (
    <Tabs defaultValue="runtime">
      <TabsList className="max-w-full overflow-x-auto" variant="underline">
        <TabsTab value="runtime">Runtime</TabsTab>
        <TabsTab value="prompt">System prompt</TabsTab>
        <TabsTab value="tools">Tools</TabsTab>
        <TabsTab value="usage">Usage</TabsTab>
        <TabsTab value="tool-calls">Tool calls</TabsTab>
        <TabsTab value="task">Task</TabsTab>
      </TabsList>
      <TabsPanel className="pt-4" value="runtime">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <RuntimeValue label="Agent ID" value={inspector.agent.id} mono />
          <RuntimeValue
            label="Parent Agent"
            value={inspector.agent.parentAgentId ?? "None"}
            mono
          />
          <RuntimeValue
            label="Provider"
            value={inspector.runtime?.model.provider ?? "Not captured"}
          />
          <RuntimeValue
            label="Model"
            value={inspector.runtime?.model.modelId ?? "Not captured"}
            mono
          />
          <RuntimeValue
            label="Working directory"
            value={inspector.runtime?.cwd ?? "Not captured"}
            mono
          />
          <RuntimeValue
            label="Snapshot captured"
            value={formatTime(inspector.runtime?.capturedAt)}
          />
          <RuntimeValue
            label="Started"
            value={formatTime(inspector.agent.startedAt)}
          />
          <RuntimeValue
            label="Completed"
            value={formatTime(inspector.agent.completedAt)}
          />
        </dl>
      </TabsPanel>
      <TabsPanel className="pt-4" value="prompt">
        <CodeBlock value={inspector.runtime?.systemPrompt ?? "Not captured"} />
      </TabsPanel>
      <TabsPanel className="pt-4" value="tools">
        {inspector.runtime?.tools.length ? (
          <div className="divide-y border-y">
            {inspector.runtime.tools.map((tool) => (
              <details className="py-3" key={tool.name}>
                <summary className="cursor-pointer font-mono font-medium text-sm">
                  {tool.name}
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-muted-foreground text-sm leading-6">
                  {tool.description}
                </p>
                {tool.promptGuidelines?.length ? (
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                    {tool.promptGuidelines.map((guideline) => (
                      <li key={guideline}>{guideline}</li>
                    ))}
                  </ul>
                ) : null}
                <CodeBlock
                  className="mt-3"
                  value={JSON.stringify(tool.parameters, null, 2)}
                />
              </details>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Not captured</p>
        )}
      </TabsPanel>
      <TabsPanel className="pt-4" value="usage">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          {[
            ["Input", inspector.usage.input],
            ["Output", inspector.usage.output],
            ["Cache read", inspector.usage.cacheRead],
            ["Cache write", inspector.usage.cacheWrite],
            ["Total tokens", inspector.usage.totalTokens],
            [
              "Cost",
              inspector.usage.cost === null
                ? "Unknown"
                : new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 6,
                  }).format(inspector.usage.cost),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className="mt-1 font-medium tabular-nums">
                {typeof value === "number" ? value.toLocaleString() : value}
              </dd>
            </div>
          ))}
        </dl>
      </TabsPanel>
      <TabsPanel className="pt-4" value="tool-calls">
        {inspector.toolStats.length > 0 ? (
          <div className="divide-y border-y text-sm">
            {inspector.toolStats.map((tool) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_repeat(4,auto)] items-baseline gap-3 py-2"
                key={tool.toolName}
              >
                <span className="min-w-0 truncate font-mono">
                  {tool.toolName}
                </span>
                <span className="tabular-nums">{tool.callCount} calls</span>
                <span className="tabular-nums">{tool.failedCount} failed</span>
                <span className="tabular-nums">{tool.durationMs} ms</span>
                <span className="tabular-nums">{tool.outputBytes} B</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No tool calls recorded
          </p>
        )}
      </TabsPanel>
      <TabsPanel className="pt-4" value="task">
        <p className="whitespace-pre-wrap text-sm leading-6">
          {inspector.task ?? "Main challenge session"}
        </p>
      </TabsPanel>
    </Tabs>
  )
}

function RuntimeValue({
  label,
  mono = false,
  value,
}: {
  label: string
  mono?: boolean
  value: string
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1"}>
        {value}
      </dd>
    </div>
  )
}

function CodeBlock({
  className,
  value,
}: {
  className?: string
  value: string
}) {
  return (
    <pre
      className={`max-w-full overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-5 ${className ?? ""}`}
    >
      <code>{value}</code>
    </pre>
  )
}
