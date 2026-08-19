import dagre from "@dagrejs/dagre"
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
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
  Puzzle,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { useNavigate } from "react-router"

import type { AgentSummary, Challenge, SchedulerInfo } from "@/api"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card"
import { agentStatusLabel } from "@/features/runs/agent-overview"
import { AgentStatusIcon } from "@/features/runs/agent-status-icon"
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

const agentNodeId = (id: string) => `agent:${id}`
const challengeNodeId = (id: string) => `challenge:${id}`
/** Agent short id — the v19 signing convention (`agent-a3f1`). */
const agentShortId = (id: string) => `agent-${id.slice(0, 4)}`

type GraphNodeData =
  | {
      kind: "scheduler"
      /** The scheduler's orchestrator agent, when active. Null when no
       * scheduler agent exists (placeholder "未启用" node; click still leads
       * to the tasks page where the scheduler is started). */
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
  | { kind: "agent"; agent: AgentSummary }

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

/** The three-layer graph (v19) — 调度者 → challenge → agent. Pure navigation:
 * every node click routes to the tasks page (scheduler → `c=orch`, challenge
 * → `c=<id>`, agent → `c=<id>&a=<id>`); finished agents collapse into the
 * aggregate archive node (expanded shows one node per attempt). The live
 * count is bounded by the container cap and the archive stays collapsed
 * unless opened, so the steady-state node count is bounded. */
function buildAgentsGraph({
  scheduler,
  agents,
  archiveOpen,
  challenges,
}: {
  scheduler?: SchedulerInfo
  agents: AgentSummary[]
  archiveOpen: boolean
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
  // orchestrator agent; no agent → the "未启用" placeholder. Either way the
  // click leads to the scheduler's tasks page (where it is started/controlled).
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

  // Layer 2: challenges with live agents, in event order. Layer 3: each live
  // attempt hangs directly off its challenge.
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
    <GraphNodeShell className={cn("w-52", finish && "opacity-60")}>
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

/** The ReactFlow canvas. Split out from AgentsGraph for provider nesting. */
function GraphCanvas({
  graph,
  graphKey,
  onActivateNode,
}: {
  graph: { nodes: Node[]; edges: Edge[] }
  graphKey: string
  onActivateNode: (node: Node) => void
}) {
  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => onActivateNode(node),
    [onActivateNode]
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
      onActivateNode(node)
    },
    [onActivateNode, graph.nodes]
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
    </ReactFlow>
  )
}

export function AgentsGraph({
  eventId,
  agents,
  scheduler,
  challenges,
}: {
  eventId: string
  /** All solver agents of the event (live + finished). */
  agents: AgentSummary[]
  scheduler?: SchedulerInfo
  /** The event's challenges (for the challenge node labels + grouping). */
  challenges: Challenge[]
}) {
  const navigate = useNavigate()
  const [archiveOpen, setArchiveOpen] = useState(false)

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
        challenges,
      }),
    [scheduler, sortedAgents, archiveOpen, challenges]
  )
  // Remount React Flow (→ re-fit-view) only when the node SET changes
  // (expand/collapse/spawn). Status-only polls keep the same key, so the
  // viewport (pan/zoom) is preserved across them.
  const graphKey = useMemo(
    () => graph.nodes.map((node) => node.id).join("|"),
    [graph]
  )

  const onActivateNode = useCallback(
    (node: Node) => {
      const data = node.data as GraphNodeData
      if (data.kind === "scheduler") {
        void navigate(`/events/${eventId}/tasks?c=orch`)
      } else if (data.kind === "challenge") {
        void navigate(`/events/${eventId}/tasks?c=${data.challengeId}`)
      } else if (data.kind === "agent") {
        const agent = data.agent
        void navigate(
          agent.challengeId
            ? `/events/${eventId}/tasks?c=${agent.challengeId}&a=${agent.id}`
            : `/events/${eventId}/tasks?c=orch`
        )
      } else if (data.kind === "archive") {
        setArchiveOpen((prev) => !prev)
      }
    },
    [eventId, navigate]
  )

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            <Network className="size-4" /> Agents Graph
          </span>
        </CardTitle>
        <CardDescription>调度者 → 题目 → agents，点击进入任务</CardDescription>
      </CardHeader>
      <CardPanel className="relative min-h-0 flex-1 overflow-hidden p-0">
        <ReactFlowProvider>
          <GraphCanvas
            graph={graph}
            graphKey={graphKey}
            onActivateNode={onActivateNode}
          />
        </ReactFlowProvider>
      </CardPanel>
    </Card>
  )
}
