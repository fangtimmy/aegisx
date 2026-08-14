import dagre from "@dagrejs/dagre"
import { useQueryClient } from "@tanstack/react-query"
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react"

import "@xyflow/react/dist/style.css"
import {
  BrainCircuit,
  ChevronDown,
  GitFork,
  Network,
  Play,
  Server,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import type { AgentSummary, RunPublic } from "@/api"
import { keys } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { runStatusLabel, statusVariant } from "@/features/runs/run-overview"
import { cn } from "@/lib/utils"

import {
  agentFinishBadge,
  EDGE_STYLE,
  GRAPH_NODE_TYPES,
  NODE_DIM,
  roleLabel,
  SCHED_NODE_ID,
  type SchedulerWithAgents,
} from "./event-agents-shared"
import { StartSchedulerDialog } from "./scheduler-config-tab"

const runNodeId = (id: string) => `run:${id}`
const agentNodeId = (id: string) => `agent:${id}`

type GraphNodeData =
  | {
      kind: "scheduler"
      /** The scheduler run + its orchestrator agent, when active. Null when
       * no scheduler run exists (placeholder "未启用" node, not clickable). */
      runId: string | null
      agentId: string | null
      status: string
    }
  | { kind: "run"; run: RunPublic; active: boolean }
  | { kind: "agent"; agent: AgentSummary; runId: string }

/** Lay out nodes top-to-bottom with dagre, writing absolute positions back
 * onto each node (React Flow needs explicit positions). */
function layoutWithDagre(
  nodes: Node[],
  edges: Edge[],
  dims: Record<string, { width: number; height: number }>
): Node[] {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({
    rankdir: "LR",
    nodesep: 28,
    ranksep: 64,
    marginx: 24,
    marginy: 24,
  })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) {
    const dim = dims[node.id] ?? { width: 160, height: 48 }
    graph.setNode(node.id, { width: dim.width, height: dim.height })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return nodes.map((node) => {
    const laid = graph.node(node.id)
    const dim = dims[node.id] ?? { width: 160, height: 48 }
    return {
      ...node,
      position: { x: laid.x - dim.width / 2, y: laid.y - dim.height / 2 },
    }
  })
}

/** Build the node/edge set for the whole event fleet, then lay it out. */
function buildAgentsGraph({
  scheduler,
  schedRun,
  runs,
  detailsById,
  openRuns,
}: {
  scheduler?: SchedulerWithAgents
  schedRun: RunPublic | null
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  openRuns: Set<string>
}): { nodes: Node[]; edges: Edge[] } {
  const rawNodes: Node[] = []
  const rawEdges: Edge[] = []
  const dims: Record<string, { width: number; height: number }> = {}
  const addNode = (
    id: string,
    type: "scheduler" | "run" | "agent",
    data: GraphNodeData
  ) => {
    rawNodes.push({ id, type, data, position: { x: 0, y: 0 } })
    dims[id] = NODE_DIM[type]
  }

  // Root: the event scheduler. When a scheduler run exists, this node IS its
  // orchestrator agent (click opens that agent's conversation) and the
  // challenge runs hang off it. When no run exists it is a non-clickable
  // "未启用" placeholder — the start control lives in the graph overlay.
  const orchAgent =
    scheduler?.agents?.find((a) => a.isEntry) ?? scheduler?.agents?.[0] ?? null
  addNode(SCHED_NODE_ID, "scheduler", {
    kind: "scheduler",
    runId: schedRun?.id ?? null,
    agentId: orchAgent?.id ?? null,
    status: schedRun ? runStatusLabel(schedRun.status) : "未启用",
  })

  // Challenge runs hang off the scheduler node when one is active; otherwise
  // they stand alone. Each expanded run exposes its agents.
  for (const run of runs) {
    addNode(runNodeId(run.id), "run", {
      kind: "run",
      run,
      active: openRuns.has(run.id),
    })
    if (schedRun) {
      rawEdges.push({
        id: `e:sched:run:${run.id}`,
        source: SCHED_NODE_ID,
        target: runNodeId(run.id),
        type: "smoothstep",
        style: EDGE_STYLE.oversee,
      })
    }
    if (!openRuns.has(run.id)) continue
    const agents = detailsById.get(run.id)?.agents ?? []
    for (const agent of agents) {
      addNode(agentNodeId(agent.id), "agent", {
        kind: "agent",
        agent,
        runId: run.id,
      })
    }
    for (const agent of agents) {
      if (agent.parentAgentId && dims[agentNodeId(agent.parentAgentId)]) {
        rawEdges.push({
          id: `e:spawn:${agent.id}`,
          source: agentNodeId(agent.parentAgentId),
          target: agentNodeId(agent.id),
          type: "smoothstep",
          style: EDGE_STYLE.spawn,
        })
      } else {
        rawEdges.push({
          id: `e:run:${run.id}:${agent.id}`,
          source: runNodeId(run.id),
          target: agentNodeId(agent.id),
          type: "smoothstep",
          style: agent.isEntry ? EDGE_STYLE.entry : EDGE_STYLE.agent,
        })
      }
    }
  }

  return { nodes: layoutWithDagre(rawNodes, rawEdges, dims), edges: rawEdges }
}

function GraphNodeShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-xs/5 transition-colors hover:border-foreground/35",
        className
      )}
    >
      {/* Invisible handles — React Flow anchors edges on them; we hide the
          dots for a cleaner look. Every node carries a target (top) and a
          source (bottom) so edges attach on both sides regardless of role. */}
      <Handle className="opacity-0!" position={Position.Left} type="target" />
      {children}
      <Handle className="opacity-0!" position={Position.Right} type="source" />
    </div>
  )
}

export function SchedulerGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "scheduler" }>
  const active = d.agentId !== null
  return (
    <GraphNodeShell className={cn("w-44", !active && "opacity-70")}>
      <BrainCircuit
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground"
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {active ? "调度者" : "调度者（未启用）"}
      </span>
      <Badge size="sm" variant="secondary">
        {d.status}
      </Badge>
    </GraphNodeShell>
  )
}

export function RunGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "run" }>
  const { run } = d
  return (
    <GraphNodeShell
      className={cn("w-56", run.status === "closed" && "opacity-60")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Server className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight font-medium">
          {run.challengeName}
        </span>
        <span className="block truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {run.orchestration}
          {run.source === "scheduler" ? " · 调度" : ""}
        </span>
      </span>
      <Badge size="sm" variant={statusVariant(run.status)}>
        {runStatusLabel(run.status)}
      </Badge>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !d.active && "-rotate-90"
        )}
      />
    </GraphNodeShell>
  )
}

export function AgentGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "agent" }>
  const { agent } = d
  const finish = agentFinishBadge(agent.status)
  return (
    <GraphNodeShell className={cn("w-48", finish && "opacity-60")}>
      <AgentStatusIcon className="[&_svg]:size-3.5" status={agent.status} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {agent.name ?? roleLabel(agent.role)}
      </span>
      {finish ? (
        <Badge size="sm" variant={finish.variant}>
          {finish.label}
        </Badge>
      ) : agent.isEntry ? (
        <Badge size="sm" variant="secondary">
          入口
        </Badge>
      ) : agent.parentAgentId ? (
        <GitFork
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
    </GraphNodeShell>
  )
}

export function AgentsGraph({
  eventId,
  runs,
  detailsById,
  scheduler,
  onSelectAgent,
}: {
  eventId: string
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  onSelectAgent: (runId: string, agentId: string) => void
}) {
  const queryClient = useQueryClient()
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => {
    // Default-expand active runs.
    return new Set(
      runs.filter((run) => run.status !== "closed").map((run) => run.id)
    )
  })
  const schedRun = scheduler?.run ?? null
  // Start-open state: the launch dialog persists the pre-start policy (model /
  // instruction / target cap) before creating the orchestrator run.
  const [startOpen, setStartOpen] = useState(false)

  // Scheduler lifecycle: the graph only hosts the start entry (there is no
  // run entity to click before start). Stop / close and the orchestrator
  // conversation live in the AgentDialog, exactly like any other run's agent.
  const invalidateScheduler = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.detail(eventId),
      }),
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(eventId),
      }),
      queryClient.invalidateQueries({ queryKey: keys.runs.byEvent(eventId) }),
      queryClient.invalidateQueries({ queryKey: keys.events.detail(eventId) }),
    ])

  const sortedRuns = [...runs].sort((left, right) => {
    const activeRank = (run: RunPublic) => (run.status === "closed" ? 1 : 0)
    return (
      activeRank(left) - activeRank(right) ||
      right.updatedAt.localeCompare(left.updatedAt)
    )
  })

  // Build + lay out the graph from the fleet state. Recomputed only when the
  // underlying data or the expand toggles change; status-only poll updates
  // with the same node set reuse the cached layout, so nothing jitters.
  const graph = useMemo(
    () =>
      buildAgentsGraph({
        scheduler,
        schedRun,
        runs: sortedRuns,
        detailsById,
        openRuns,
      }),
    [scheduler, schedRun, sortedRuns, detailsById, openRuns]
  )
  // Remount React Flow (→ re-fit-view) only when the node SET changes
  // (expand/collapse/spawn). Status-only polls keep the same key, so the
  // viewport (pan/zoom) is preserved across them.
  const graphKey = useMemo(
    () => graph.nodes.map((node) => node.id).join("|"),
    [graph]
  )
  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      const data = node.data as GraphNodeData
      if (data.kind === "scheduler") {
        // The scheduler node IS the orchestrator agent — open its conversation.
        if (data.runId && data.agentId) onSelectAgent(data.runId, data.agentId)
      } else if (data.kind === "run") {
        setOpenRuns((prev) => {
          const next = new Set(prev)
          if (next.has(data.run.id)) next.delete(data.run.id)
          else next.add(data.run.id)
          return next
        })
      } else {
        onSelectAgent(data.runId, data.agent.id)
      }
    },
    [onSelectAgent]
  )

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            <Network className="size-4" /> Agents Graph
          </span>
        </CardTitle>
        <CardDescription>调度者 → 任务 → agents</CardDescription>
      </CardHeader>
      <CardPanel className="relative min-h-0 flex-1 overflow-hidden p-0">
        <ReactFlow
          edges={graph.edges}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          key={graphKey}
          minZoom={0.2}
          nodeTypes={GRAPH_NODE_TYPES}
          nodes={graph.nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={onNodeClick}
          panOnScroll
          panOnScrollSpeed={1}
          proOptions={{ hideAttribution: true }}
          zoomOnScroll={false}
        >
          <Background color="var(--border)" gap={22} size={1} />
          <Controls position="bottom-right" showInteractive={false} />
          {/* Scheduler lifecycle: the graph only hosts the start entry (there
                is no run entity to click before start). Stop / close and the
                orchestrator conversation live in the AgentDialog, exactly like
                any other run's agent. */}
          <Panel
            className="flex flex-wrap items-center gap-1.5"
            position="top-right"
          >
            {(!schedRun || schedRun.status === "closed") && (
              <Button
                onClick={() => setStartOpen(true)}
                size="sm"
                type="button"
              >
                <Play /> 启动调度者
              </Button>
            )}
          </Panel>
        </ReactFlow>
      </CardPanel>
      {startOpen && (
        <StartSchedulerDialog
          config={scheduler?.config}
          eventId={eventId}
          onClose={() => setStartOpen(false)}
          onStarted={invalidateScheduler}
        />
      )}
    </Card>
  )
}
