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
  Network,
  Pause,
  Play,
  Puzzle,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import type { AgentSummary, Challenge, SchedulerInfo } from "@/api"
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
import { agentStatusLabel } from "@/features/runs/agent-overview"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import {
  agentFinishBadge,
  ARCHIVE_NODE_ID,
  EDGE_STYLE,
  isAgentFinished,
  NODE_DIM,
  roleLabel,
  SCHED_NODE_ID,
} from "./event-agents-shared"
import { StartSchedulerDialog } from "./scheduler-config-tab"

const agentNodeId = (id: string) => `agent:${id}`
const challengeNodeId = (id: string) => `challenge:${id}`
/** Agent short id — the v19 signing convention (`agent-a3f1`). */
const agentShortId = (id: string) => `agent-${id.slice(0, 4)}`

type GraphNodeData =
  | {
      kind: "scheduler"
      /** The scheduler's orchestrator agent, when active. Null when no
       * scheduler agent exists (placeholder "未启用" node, not clickable). */
      agentId: string | null
      status: string
    }
  | {
      kind: "challenge"
      challengeId: string
      name: string
      category: string | null
      points: number | null
      activeAgentCount: number
    }
  | { kind: "archive"; count: number; open: boolean }
  | { kind: "agent"; agent: AgentSummary; selected: boolean }

/** Lay out nodes left-to-right with dagre, writing absolute positions back
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
    ranksep: 88,
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

/** The three-layer graph (v19) — 调度者 → challenge → agent. Each challenge
 * node hosts its live solver attempts; finished agents (completed / aborted /
 * failed) collapse into the aggregate archive node (default closed; expanded
 * shows one node per attempt). The live count is bounded by the container
 * cap (W4) and the archive stays collapsed unless opened, so the
 * steady-state node count is bounded. */
function buildAgentsGraph({
  scheduler,
  agents,
  archiveOpen,
  selected,
  challenges,
}: {
  scheduler?: SchedulerInfo
  agents: AgentSummary[]
  archiveOpen: boolean
  selected: string | null
  challenges: Challenge[]
}): { nodes: Node[]; edges: Edge[] } {
  const rawNodes: Node[] = []
  const rawEdges: Edge[] = []
  const dims: Record<string, { width: number; height: number }> = {}
  const addNode = (
    id: string,
    type: "scheduler" | "challenge" | "archive" | "agent",
    data: GraphNodeData
  ) => {
    rawNodes.push({ id, type, data, position: { x: 0, y: 0 } })
    dims[id] = NODE_DIM[type]
  }
  const addAgent = (agent: AgentSummary, root: string) => {
    addNode(agentNodeId(agent.id), "agent", {
      kind: "agent",
      agent,
      selected: selected === agent.id,
    })
    rawEdges.push({
      id: `e:agent:${agent.id}`,
      source: root,
      target: agentNodeId(agent.id),
      type: "smoothstep",
      style: EDGE_STYLE.agent,
    })
  }

  // Layer 1: the scheduler. When a scheduler agent exists, this node IS the
  // orchestrator agent (click opens its conversation) and the challenges
  // hang off it. No agent → non-clickable "未启用" node.
  const orchAgent = scheduler?.agent ?? null
  addNode(SCHED_NODE_ID, "scheduler", {
    kind: "scheduler",
    agentId: orchAgent?.id ?? null,
    status: orchAgent ? agentStatusLabel(orchAgent.status) : "未启用",
  })

  const active = agents.filter((agent) => !isAgentFinished(agent))
  const finished = agents.filter((agent) => isAgentFinished(agent))

  if (finished.length > 0) {
    addNode(ARCHIVE_NODE_ID, "archive", {
      kind: "archive",
      count: finished.length,
      open: archiveOpen,
    })
    rawEdges.push({
      id: `e:archive`,
      source: SCHED_NODE_ID,
      target: ARCHIVE_NODE_ID,
      type: "smoothstep",
      style: EDGE_STYLE.agent,
    })
  }

  // Layer 2: challenges with live agents, in event order (the challenge
  // node is the knowledge base + IM entry). Layer 3: each live attempt
  // hangs directly off its challenge.
  const activeByChallenge = new Map<string, AgentSummary[]>()
  for (const agent of active) {
    if (!agent.challengeId) continue
    const list = activeByChallenge.get(agent.challengeId) ?? []
    list.push(agent)
    activeByChallenge.set(agent.challengeId, list)
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
    const attempts = activeByChallenge.get(challengeId)!
    const meta = challengeById.get(challengeId)
    addNode(challengeNodeId(challengeId), "challenge", {
      kind: "challenge",
      challengeId,
      name: meta?.name ?? attempts[0].challengeName,
      category: meta?.category ?? null,
      points: meta?.points ?? null,
      activeAgentCount: attempts.length,
    })
    rawEdges.push({
      id: `e:sched:challenge:${challengeId}`,
      source: SCHED_NODE_ID,
      target: challengeNodeId(challengeId),
      type: "smoothstep",
      style: EDGE_STYLE.challenge,
    })
    for (const agent of attempts) {
      addAgent(agent, challengeNodeId(challengeId))
    }
  }

  if (archiveOpen)
    for (const agent of finished) addAgent(agent, ARCHIVE_NODE_ID)

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
          dots for a cleaner look. Every node carries a target (left) and a
          source (right) so edges attach on both sides regardless of role. */}
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
        {d.activeAgentCount} agent
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

function AgentGraphNode({ data }: NodeProps) {
  const d = data as Extract<GraphNodeData, { kind: "agent" }>
  const { agent } = d
  const finish = agentFinishBadge(agent.status)
  return (
    <GraphNodeShell
      className={cn("w-52", finish && "opacity-60")}
      selected={d.selected}
    >
      <AgentStatusIcon className="[&_svg]:size-3.5" status={agent.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight">
          {agent.name ?? roleLabel(agent.role)}
        </span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {agentShortId(agent.id)} ·{" "}
          {agent.source === "scheduler" ? "调度" : "手动"}
        </span>
      </span>
      {finish && (
        <Badge size="sm" variant={finish.variant}>
          {finish.label}
        </Badge>
      )}
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
  agent: AgentGraphNode,
} satisfies NodeTypes

/** The ReactFlow canvas (inside the provider so useReactFlow can focus the
 * selected node). Split out from AgentsGraph because useReactFlow needs the
 * provider above it. */
function GraphCanvas({
  graph,
  graphKey,
  schedAgent,
  paused,
  pausePending,
  resumePending,
  closePending,
  selected,
  onOpenAgent,
  onOpenChallenge,
  onToggleArchive,
  onPauseScheduler,
  onResumeScheduler,
  onCloseScheduler,
  onStartOpen,
}: {
  graph: { nodes: Node[]; edges: Edge[] }
  graphKey: string
  schedAgent: AgentSummary | null
  paused: boolean
  pausePending: boolean
  resumePending: boolean
  closePending: boolean
  selected: string | null
  onOpenAgent: (agentId: string) => void
  onOpenChallenge: (challengeId: string) => void
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
    if (focusedAgentId.current === selected) return
    const node = graph.nodes.find((n) => n.id === agentNodeId(selected))
    if (!node) return
    focusedAgentId.current = selected
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
        if (data.agentId) onOpenAgent(data.agentId)
      } else if (data.kind === "challenge") {
        // The challenge node IS the knowledge base — open its IM.
        onOpenChallenge(data.challengeId)
      } else if (data.kind === "agent") {
        onOpenAgent(data.agent.id)
      } else if (data.kind === "archive") {
        onToggleArchive()
      }
    },
    [onOpenAgent, onOpenChallenge, onToggleArchive]
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
          关闭; paused → 恢复; closed/no agent → 启动 (restore semantics). */}
      <Panel
        className="flex flex-wrap items-center gap-1.5"
        position="top-right"
      >
        {schedAgent && schedAgent.status !== "aborted" ? (
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
  agents,
  scheduler,
  challenges,
  onOpenAgent,
  onOpenChallenge,
  selected,
}: {
  eventId: string
  /** All solver agents of the event (live + finished). */
  agents: AgentSummary[]
  scheduler?: SchedulerInfo
  /** The event's challenges (for the challenge node labels + grouping). */
  challenges: Challenge[]
  /** Graph node click → open the agent dialog (the ONLY dialog entry). */
  onOpenAgent: (agentId: string) => void
  /** Challenge node click → open the challenge-level IM (knowledge base). */
  onOpenChallenge: (challengeId: string) => void
  /** W7.2: highlighted agent (from the left panel / timeline / queue); the
   * graph opens the archive when needed + focuses it, but does NOT open a
   * dialog. */
  selected: string | null
}) {
  const queryClient = useQueryClient()
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const schedAgent = scheduler?.agent ?? null
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
      queryClient.invalidateQueries({ queryKey: keys.agents.fleet(eventId) }),
    ])

  // W3.3 lifecycle actions (pause keeps the container warm; close releases it
  // — the agent stays cold-restorable; start restores memory by default).
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

  const sortedAgents = useMemo(
    () =>
      [...agents].sort(
        (left, right) =>
          Number(isAgentFinished(left)) - Number(isAgentFinished(right)) ||
          left.createdAt.localeCompare(right.createdAt)
      ),
    [agents]
  )

  // Build + lay out the graph from the fleet state. Recomputed only when the
  // underlying data or the archive toggle changes; status-only poll updates
  // with the same node set reuse the cached layout, so nothing jitters.
  const graph = useMemo(
    () =>
      buildAgentsGraph({
        scheduler,
        agents: sortedAgents,
        archiveOpen,
        selected,
        challenges,
      }),
    [scheduler, sortedAgents, archiveOpen, selected, challenges]
  )
  // Remount React Flow (→ re-fit-view) only when the node SET changes
  // (expand/collapse/spawn). Status-only polls keep the same key, so the
  // viewport (pan/zoom) is preserved across them.
  const graphKey = useMemo(
    () => graph.nodes.map((node) => node.id).join("|"),
    [graph]
  )

  // W7.2: a selected finished agent opens the archive so its node is
  // visible for the viewport focus.
  useEffect(() => {
    if (!selected) return
    const agent = agents.find((a) => a.id === selected)
    if (agent && isAgentFinished(agent)) setArchiveOpen(true)
  }, [selected, agents])

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
        <CardDescription>调度者 → 题目 → agents</CardDescription>
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
            pausePending={pauseScheduler.isPending}
            paused={paused}
            resumePending={resumeScheduler.isPending}
            schedAgent={schedAgent}
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
