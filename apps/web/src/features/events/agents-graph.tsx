import dagre from "@dagrejs/dagre"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react"

import "@xyflow/react/dist/style.css"
import {
  Archive,
  BrainCircuit,
  ChevronDown,
  GitFork,
  Network,
  Pause,
  Play,
  Puzzle,
  Server,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import type { AgentSummary, Challenge, RunPublic } from "@/api"
import { keys, schedulerApi } from "@/api"
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
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import {
  agentFinishBadge,
  ARCHIVE_NODE_ID,
  EDGE_STYLE,
  NODE_DIM,
  roleLabel,
  SCHED_NODE_ID,
  type SchedulerWithAgents,
} from "./event-agents-shared"
import { StartSchedulerDialog } from "./scheduler-config-tab"

const runNodeId = (id: string) => `run:${id}`
const agentNodeId = (id: string) => `agent:${id}`
const challengeNodeId = (id: string) => `challenge:${id}`
/** Run short id — the v17 signing convention (`run-a3f1`). */
const runShortId = (id: string) => `run-${id.slice(0, 4)}`

type SelectedAgent = { runId: string; agentId: string } | null

type GraphNodeData =
  | {
      kind: "scheduler"
      /** The scheduler run + its orchestrator agent, when active. Null when
       * no scheduler run exists (placeholder "未启用" node, not clickable). */
      runId: string | null
      agentId: string | null
      status: string
    }
  | {
      kind: "challenge"
      challengeId: string
      name: string
      category: string | null
      points: number | null
      activeRunCount: number
    }
  | { kind: "archive"; count: number; open: boolean }
  | { kind: "run"; run: RunPublic; active: boolean }
  | { kind: "agent"; agent: AgentSummary; runId: string; selected: boolean }

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

/** W7.2: the four-layer graph (v17) — 调度者 (scheduler root) → challenge
 * (each challenge with active runs; the v17 knowledge base + IM entry) → run
 * (hangs off its challenge; source badge 调度/手动) → agent. Archived runs
 * collapse into the aggregate node (default closed; expanded shows runs).
 * Active run count is bounded by the container cap (W4), the archive stays
 * collapsed unless opened, so the steady-state node count is bounded. */
function buildAgentsGraph({
  scheduler,
  schedRun,
  runs,
  detailsById,
  openRuns,
  archiveOpen,
  selected,
  challenges,
}: {
  scheduler?: SchedulerWithAgents
  schedRun: RunPublic | null
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  openRuns: Set<string>
  archiveOpen: boolean
  selected: SelectedAgent
  challenges: Challenge[]
}): { nodes: Node[]; edges: Edge[] } {
  const rawNodes: Node[] = []
  const rawEdges: Edge[] = []
  const dims: Record<string, { width: number; height: number }> = {}
  const addNode = (
    id: string,
    type: "scheduler" | "challenge" | "archive" | "run" | "agent",
    data: GraphNodeData
  ) => {
    rawNodes.push({ id, type, data, position: { x: 0, y: 0 } })
    dims[id] = NODE_DIM[type]
  }

  // Group 1: the scheduler. When a scheduler run exists, this node IS its
  // orchestrator agent (click opens that agent's conversation) and the active
  // scheduler-source runs hang off it. No run → non-clickable "未启用" node.
  const orchAgent =
    scheduler?.agents?.find((a) => a.isEntry) ?? scheduler?.agents?.[0] ?? null
  addNode(SCHED_NODE_ID, "scheduler", {
    kind: "scheduler",
    runId: schedRun?.id ?? null,
    agentId: orchAgent?.id ?? null,
    status: schedRun ? runStatusLabel(schedRun.status) : "未启用",
  })

  const active = runs.filter((run) => run.status !== "closed")
  const closed = runs.filter((run) => run.status === "closed")

  if (closed.length > 0) {
    addNode(ARCHIVE_NODE_ID, "archive", {
      kind: "archive",
      count: closed.length,
      open: archiveOpen,
    })
  }

  const addRun = (run: RunPublic, root: string) => {
    addNode(runNodeId(run.id), "run", {
      kind: "run",
      run,
      active: openRuns.has(run.id),
    })
    rawEdges.push({
      id: `e:root:run:${run.id}`,
      source: root,
      target: runNodeId(run.id),
      type: "smoothstep",
      style: EDGE_STYLE.oversee,
    })
    if (!openRuns.has(run.id)) return
    const agents = detailsById.get(run.id)?.agents ?? []
    for (const agent of agents) {
      addNode(agentNodeId(agent.id), "agent", {
        kind: "agent",
        agent,
        runId: run.id,
        selected: selected?.agentId === agent.id,
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

  // Four layers: active runs group by challenge; the challenge node is the
  // v17 knowledge base + IM entry (manual runs hang off their challenge too,
  // told apart by the run node's 调度/手动 badge).
  const activeByChallenge = new Map<string, RunPublic[]>()
  for (const run of active) {
    if (!run.challengeId) continue
    const list = activeByChallenge.get(run.challengeId) ?? []
    list.push(run)
    activeByChallenge.set(run.challengeId, list)
  }
  const challengeById = new Map(challenges.map((ch) => [ch.id, ch]))
  const challengeOrder = challenges.map((ch) => ch.id)
  const challengeIds = [...activeByChallenge.keys()].sort((a, b) => {
    const ia = challengeOrder.indexOf(a)
    const ib = challengeOrder.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  for (const challengeId of challengeIds) {
    const runs_ = activeByChallenge.get(challengeId)!
    const meta = challengeById.get(challengeId)
    addNode(challengeNodeId(challengeId), "challenge", {
      kind: "challenge",
      challengeId,
      name: meta?.name ?? runs_[0].challengeName,
      category: meta?.category ?? null,
      points: meta?.points ?? null,
      activeRunCount: runs_.length,
    })
    rawEdges.push({
      id: `e:sched:challenge:${challengeId}`,
      source: SCHED_NODE_ID,
      target: challengeNodeId(challengeId),
      type: "smoothstep",
      style: EDGE_STYLE.challenge,
    })
    for (const run of runs_) addRun(run, challengeNodeId(challengeId))
  }

  if (archiveOpen) for (const run of closed) addRun(run, ARCHIVE_NODE_ID)

  return { nodes: layoutWithDagre(rawNodes, rawEdges, dims), edges: rawEdges }
}

function GraphNodeShell({
  children,
  className,
  selected = false,
}: {
  children: React.ReactNode
  className?: string
  selected?: boolean
}) {
  return (
    <div
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-xs/5 transition-colors hover:border-foreground/35",
        selected && "ring-2 ring-primary",
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

function SchedulerGraphNode({ data }: NodeProps) {
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

function ChallengeGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "challenge" }>
  return (
    <GraphNodeShell className="w-52">
      <Puzzle className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight font-medium">
          {d.name}
        </span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {d.category ?? "未分类"}
          {d.points != null ? ` · ${d.points} 分` : ""}
        </span>
      </span>
      <Badge size="sm" variant="secondary">
        {d.activeRunCount} run
      </Badge>
    </GraphNodeShell>
  )
}

function ArchiveGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "archive" }>
  return (
    <GraphNodeShell className="w-44">
      <Archive className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        已归档 ×{d.count}
      </span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !d.open && "-rotate-90"
        )}
      />
    </GraphNodeShell>
  )
}

function RunGraphNode({ data }: NodeProps) {
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
        <span className="block truncate font-mono text-xs leading-tight">
          {runShortId(run.id)}
        </span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {run.source === "scheduler" ? "调度" : "手动"}
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

function AgentGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "agent" }>
  const { agent } = d
  const finish = agentFinishBadge(agent.status)
  return (
    <GraphNodeShell
      className={cn("w-48", finish && "opacity-60")}
      selected={d.selected}
    >
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

// React Flow node-type registry — lives here (not in event-agents-shared)
// because only the graph uses it, and defining it in shared would import the
// node components back from this module (an ESM cycle).
const GRAPH_NODE_TYPES = {
  scheduler: SchedulerGraphNode,
  challenge: ChallengeGraphNode,
  archive: ArchiveGraphNode,
  run: RunGraphNode,
  agent: AgentGraphNode,
} satisfies NodeTypes

/** The ReactFlow canvas (inside the provider so useReactFlow can focus the
 * selected node). Split out from AgentsGraph because useReactFlow needs the
 * provider above it. */
function GraphCanvas({
  graph,
  graphKey,
  schedRun,
  paused,
  pausePending,
  resumePending,
  closePending,
  selected,
  onOpenAgent,
  onOpenChallenge,
  onToggleRun,
  onToggleArchive,
  onPauseScheduler,
  onResumeScheduler,
  onCloseScheduler,
  onStartOpen,
}: {
  graph: { nodes: Node[]; edges: Edge[] }
  graphKey: string
  schedRun: RunPublic | null
  paused: boolean
  pausePending: boolean
  resumePending: boolean
  closePending: boolean
  selected: SelectedAgent
  onOpenAgent: (runId: string, agentId: string) => void
  onOpenChallenge: (challengeId: string) => void
  onToggleRun: (runId: string) => void
  onToggleArchive: () => void
  onPauseScheduler: () => void
  onResumeScheduler: () => void
  onCloseScheduler: () => void
  onStartOpen: () => void
}) {
  const flow = useReactFlow()
  /** W7.2 viewport focus: center the selected agent once per selection (not on
   * every poll — polls change graph.nodes identity). */
  const focusedAgentId = useRef<string | null>(null)
  useEffect(() => {
    if (!selected) return
    if (focusedAgentId.current === selected.agentId) return
    const node = graph.nodes.find((n) => n.id === agentNodeId(selected.agentId))
    if (!node) return
    focusedAgentId.current = selected.agentId
    const dim = NODE_DIM.agent
    void flow.setCenter(
      node.position.x + dim.width / 2,
      node.position.y + dim.height / 2,
      { zoom: 1, duration: 300 }
    )
  }, [selected, graph, flow])

  const activateNode = useCallback(
    (node: Node) => {
      const data = node.data as GraphNodeData
      if (data.kind === "scheduler") {
        // The scheduler node IS the orchestrator agent — open its conversation.
        if (data.runId && data.agentId) onOpenAgent(data.runId, data.agentId)
      } else if (data.kind === "challenge") {
        // The challenge node IS the v17 knowledge base — open its IM.
        onOpenChallenge(data.challengeId)
      } else if (data.kind === "run") {
        onToggleRun(data.run.id)
      } else if (data.kind === "agent") {
        onOpenAgent(data.runId, data.agent.id)
      } else if (data.kind === "archive") {
        onToggleArchive()
      }
    },
    [onOpenAgent, onOpenChallenge, onToggleRun, onToggleArchive]
  )

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => activateNode(node),
    [activateNode]
  )

  // Enter/Space on a focused node runs the same activation as a click — RF's
  // built-in keydown only toggles selection, it never fires onNodeClick.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return
      const id = (event.target as HTMLElement).closest<HTMLElement>(
        ".react-flow__node"
      )?.dataset.id
      const node = id ? graph.nodes.find((n) => n.id === id) : undefined
      if (!node) return
      event.preventDefault()
      activateNode(node)
    },
    [activateNode, graph.nodes]
  )

  return (
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
      onKeyDown={onKeyDown}
      onlyRenderVisibleElements
      panOnScroll
      panOnScrollSpeed={1}
      proOptions={{ hideAttribution: true }}
      zoomOnScroll={false}
    >
      <Background color="var(--border)" gap={22} size={1} />
      <Controls position="bottom-right" showInteractive={false} />
      {/* W3.3 scheduler lifecycle, state-driven: active+not paused → 暂停 /
          关闭; paused → 恢复; closed/no run → 启动 (restore semantics). */}
      <Panel
        className="flex flex-wrap items-center gap-1.5"
        position="top-right"
      >
        {schedRun && schedRun.status !== "closed" ? (
          paused ? (
            <Button
              loading={resumePending}
              onClick={onResumeScheduler}
              size="sm"
              type="button"
            >
              <Play /> 恢复
            </Button>
          ) : (
            <>
              <Button
                loading={pausePending}
                onClick={onPauseScheduler}
                size="sm"
                type="button"
                variant="outline"
              >
                <Pause /> 暂停
              </Button>
              <Button
                loading={closePending}
                onClick={onCloseScheduler}
                size="sm"
                type="button"
                variant="outline"
              >
                <Archive /> 关闭
              </Button>
            </>
          )
        ) : (
          <Button onClick={onStartOpen} size="sm" type="button">
            <Play /> 启动调度者
          </Button>
        )}
      </Panel>
    </ReactFlow>
  )
}

export function AgentsGraph({
  eventId,
  runs,
  detailsById,
  scheduler,
  challenges,
  onOpenAgent,
  onOpenChallenge,
  selected,
}: {
  eventId: string
  runs: RunPublic[]
  detailsById: Map<string, { run: RunPublic; agents: AgentSummary[] }>
  scheduler?: SchedulerWithAgents
  /** The event's challenges (for the challenge node labels + grouping). */
  challenges: Challenge[]
  /** W7.1: graph node click → open the agent dialog (the ONLY dialog entry). */
  onOpenAgent: (runId: string, agentId: string) => void
  /** Challenge node click → open the challenge-level IM (v17 knowledge base). */
  onOpenChallenge: (challengeId: string) => void
  /** W7.2: highlighted agent (from the left panel / timeline / queue); the
   * graph auto-expands its run + focuses it, but does NOT open a dialog. */
  selected: SelectedAgent
}) {
  const queryClient = useQueryClient()
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => {
    // Default-expand active runs.
    return new Set(
      runs.filter((run) => run.status !== "closed").map((run) => run.id)
    )
  })
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const schedRun = scheduler?.run ?? null
  const config = scheduler?.config
  const paused = config?.paused ?? false

  const invalidateScheduler = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.detail(eventId),
      }),
      queryClient.invalidateQueries({
        queryKey: keys.scheduler.queue(eventId),
      }),
      queryClient.invalidateQueries({ queryKey: keys.runs.fleet(eventId) }),
    ])

  // W3.3 lifecycle actions (pause keeps the container warm; close releases it
  // — the run stays cold-restorable; start restores memory by default).
  const pauseScheduler = useMutation({
    mutationFn: () => schedulerApi.pauseScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已暂停")
      void invalidateScheduler()
    },
    onError: (error) => toast.error("暂停调度者失败", error.message),
  })
  const resumeScheduler = useMutation({
    mutationFn: () => schedulerApi.resumeScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已恢复")
      void invalidateScheduler()
    },
    onError: (error) => toast.error("恢复调度者失败", error.message),
  })
  const closeScheduler = useMutation({
    mutationFn: () => schedulerApi.closeScheduler(eventId),
    onSuccess: () => {
      toast.success("调度者已关闭")
      void invalidateScheduler()
    },
    onError: (error) => toast.error("关闭调度者失败", error.message),
  })

  const sortedRuns = useMemo(
    () =>
      [...runs].sort((left, right) => {
        const activeRank = (run: RunPublic) => (run.status === "closed" ? 1 : 0)
        return (
          activeRank(left) - activeRank(right) ||
          right.updatedAt.localeCompare(left.updatedAt)
        )
      }),
    [runs]
  )

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
        archiveOpen,
        selected,
        challenges,
      }),
    [
      scheduler,
      schedRun,
      sortedRuns,
      detailsById,
      openRuns,
      archiveOpen,
      selected,
      challenges,
    ]
  )
  // Remount React Flow (→ re-fit-view) only when the node SET changes
  // (expand/collapse/spawn). Status-only polls keep the same key, so the
  // viewport (pan/zoom) is preserved across them.
  const graphKey = useMemo(
    () => graph.nodes.map((node) => node.id).join("|"),
    [graph]
  )

  // W7.2: the selected run is auto-expanded (and the archive opened when the
  // run is closed) so its agent node is visible for the viewport focus.
  useEffect(() => {
    if (!selected) return
    setOpenRuns((prev) => {
      if (prev.has(selected.runId)) return prev
      const next = new Set(prev)
      next.add(selected.runId)
      return next
    })
    const run = runs.find((r) => r.id === selected.runId)
    if (run?.status === "closed") setArchiveOpen(true)
  }, [selected, runs])

  const onToggleRun = useCallback((runId: string) => {
    setOpenRuns((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }, [])
  const onToggleArchive = useCallback(() => {
    setArchiveOpen((prev) => !prev)
  }, [])

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
        <ReactFlowProvider>
          <GraphCanvas
            closePending={closeScheduler.isPending}
            graph={graph}
            graphKey={graphKey}
            onCloseScheduler={() => closeScheduler.mutate()}
            onOpenAgent={onOpenAgent}
            onOpenChallenge={onOpenChallenge}
            onPauseScheduler={() => pauseScheduler.mutate()}
            onResumeScheduler={() => resumeScheduler.mutate()}
            onStartOpen={() => setStartOpen(true)}
            onToggleArchive={onToggleArchive}
            onToggleRun={onToggleRun}
            pausePending={pauseScheduler.isPending}
            paused={paused}
            resumePending={resumeScheduler.isPending}
            schedRun={schedRun}
            selected={selected}
          />
        </ReactFlowProvider>
      </CardPanel>
      {startOpen && (
        <StartSchedulerDialog
          config={config}
          eventId={eventId}
          onClose={() => setStartOpen(false)}
          onStarted={invalidateScheduler}
        />
      )}
    </Card>
  )
}
