import { graphlib, layout } from "@dagrejs/dagre"
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react"

import "@xyflow/react/dist/style.css"
import {
  Activity,
  Archive,
  BrainCircuit,
  ChevronDown,
  Network,
  Puzzle,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react"
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
  ACTIVE_NODE_ID,
  ARCHIVE_NODE_ID,
  EDGE_STYLE,
  isAgentFinished,
  NODE_DIM,
  roleLabel,
} from "./event-agents-shared"

const agentNodeId = (id: string) => `agent:${id}`
const challengeNodeId = (id: string) => `challenge:${id}`
const archivedChallengeNodeId = (id: string) => `archive:challenge:${id}`
const ARCHIVED_SCHED_NODE_ID = "archive:sched"
/** Agent short id — the v19 signing convention (`agent-a3f1`). */
const agentShortId = (id: string) => `agent-${id.slice(0, 4)}`

type GraphNodeData =
  | { kind: "active"; count: number }
  | { kind: "archive"; count: number; open: boolean }
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
      agentCount: number
    }
  | { kind: "agent"; agent: AgentSummary }

type ActiveFlowNode = Node<Extract<GraphNodeData, { kind: "active" }>, "active">
type ArchiveFlowNode = Node<
  Extract<GraphNodeData, { kind: "archive" }>,
  "archive"
>
type SchedulerFlowNode = Node<
  Extract<GraphNodeData, { kind: "scheduler" }>,
  "scheduler"
>
type ChallengeFlowNode = Node<
  Extract<GraphNodeData, { kind: "challenge" }>,
  "challenge"
>
type AgentFlowNode = Node<Extract<GraphNodeData, { kind: "agent" }>, "agent">
type GraphFlowNode = Node<GraphNodeData>

/** Lay out nodes left-to-right with dagre, writing absolute positions back
 * onto each node (React Flow needs explicit positions). */
function layoutWithDagre(
  nodes: GraphFlowNode[],
  edges: Edge[],
  dims: Record<string, { width: number; height: number }>
): GraphFlowNode[] {
  const graph = new graphlib.Graph()
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
  layout(graph)
  return nodes.map((node) => {
    const laid = graph.node(node.id)
    const dim = dims[node.id] ?? { width: 160, height: 48 }
    return {
      ...node,
      position: { x: laid.x - dim.width / 2, y: laid.y - dim.height / 2 },
    }
  })
}

function groupByChallenge(list: AgentSummary[]) {
  const map = new Map<string, AgentSummary[]>()
  for (const agent of list) {
    if (!agent.challengeId) continue
    const bucket = map.get(agent.challengeId) ?? []
    bucket.push(agent)
    map.set(agent.challengeId, bucket)
  }
  return map
}

/** The three-layer graph (v19) — {活跃/已归档} → {题目/调度者} → agent.
 * Pure navigation: every node click routes to the tasks page (scheduler →
 * `c=orch`, challenge → `c=<id>`, agent → `c=<id>&a=<id>`). Live attempts
 * hang off their challenge under the 活跃 root; finished agents hang off the
 * same challenges under the 已归档 root (collapsed by default — the root
 * carries the aggregate count, expanding shows per-challenge groups). The
 * live count is bounded by the container cap, so the steady-state node count
 * stays bounded. */
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
}): { nodes: GraphFlowNode[]; edges: Edge[] } {
  const rawNodes: GraphFlowNode[] = []
  const rawEdges: Edge[] = []
  const dims: Record<string, { width: number; height: number }> = {}
  /** Archive challenge leaves — reflowed into a grid after the dagre pass. */
  const archiveLeafIds = new Set<string>()
  const addNode = (
    id: string,
    type: "active" | "archive" | "scheduler" | "challenge" | "agent",
    data: GraphNodeData
  ) => {
    rawNodes.push({ id, type, data, position: { x: 0, y: 0 } })
    dims[id] = NODE_DIM[type]
  }
  const addEdge = (
    id: string,
    source: string,
    target: string,
    style: Edge["style"]
  ) => {
    rawEdges.push({ id, source, target, type: "smoothstep", style })
  }
  const addAgent = (agent: AgentSummary, root: string) => {
    addNode(agentNodeId(agent.id), "agent", { kind: "agent", agent })
    addEdge(
      `e:agent:${agent.id}`,
      root,
      agentNodeId(agent.id),
      EDGE_STYLE.agent
    )
  }
  const addSchedulerNode = (
    id: string,
    agent: AgentSummary | null,
    root: string
  ) => {
    addNode(id, "scheduler", {
      kind: "scheduler",
      agentId: agent?.id ?? null,
      status: agent ? agentStatusLabel(agent.status) : "未启用",
    })
    addEdge(`e:${id}`, root, id, EDGE_STYLE.challenge)
  }

  const active = agents.filter((agent) => !isAgentFinished(agent))
  const finished = agents.filter((agent) => isAgentFinished(agent))
  const schedAgent = scheduler?.agent ?? null
  const schedFinished = schedAgent !== null && isAgentFinished(schedAgent)

  // Layer 2 helpers: challenges with agents, in event order.
  const challengeById = new Map(challenges.map((ch) => [ch.id, ch]))
  const challengeOrder = challenges.map((ch) => ch.id)
  const challengeIdsOf = (map: Map<string, AgentSummary[]>) =>
    [...map.keys()].toSorted((a, b) => {
      const ia = challengeOrder.indexOf(a)
      const ib = challengeOrder.indexOf(b)
      if (ia === -1 && ib === -1) return a.localeCompare(b)
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })
  const addChallengeNode = (
    id: string,
    root: string,
    challengeId: string,
    attempts: AgentSummary[],
    { withAgents = true }: { withAgents?: boolean } = {}
  ) => {
    const meta = challengeById.get(challengeId)
    addNode(id, "challenge", {
      kind: "challenge",
      challengeId,
      name: meta?.name ?? attempts[0].challengeName,
      category: meta?.category ?? null,
      points: meta?.points ?? null,
      agentCount: attempts.length,
    })
    addEdge(`e:${id}`, root, id, EDGE_STYLE.challenge)
    // Archive challenges render their attempts as the node's count badge
    // instead of 1:1 leaf nodes — a few hundred agent nodes can neither fit
    // the viewport nor stay readable (details live one click away on tasks).
    if (withAgents) for (const agent of attempts) addAgent(agent, id)
    else archiveLeafIds.add(id)
  }
  // Layer 1: the 活跃 root. Layer 2 under it: the scheduler (live or the
  // "未启用" placeholder) + challenges with live agents. Layer 3: each live
  // attempt hangs directly off its challenge.
  addNode(ACTIVE_NODE_ID, "active", {
    kind: "active",
    count: active.length + (schedFinished || !schedAgent ? 0 : 1),
  })
  if (!schedFinished) addSchedulerNode("sched", schedAgent, ACTIVE_NODE_ID)
  const activeByChallenge = groupByChallenge(active)
  for (const challengeId of challengeIdsOf(activeByChallenge)) {
    addChallengeNode(
      challengeNodeId(challengeId),
      ACTIVE_NODE_ID,
      challengeId,
      activeByChallenge.get(challengeId)!
    )
  }

  // The 已归档 branch: hidden with zero finished entities; collapsed shows
  // only the root (aggregate count), expanded re-groups the same challenges
  // with their finished attempts.
  const archiveCount = finished.length + (schedFinished ? 1 : 0)
  if (archiveCount > 0) {
    addNode(ARCHIVE_NODE_ID, "archive", {
      kind: "archive",
      count: archiveCount,
      open: archiveOpen,
    })
    if (archiveOpen) {
      if (schedFinished) {
        addSchedulerNode(ARCHIVED_SCHED_NODE_ID, schedAgent, ARCHIVE_NODE_ID)
        // Grid slot keeps it from dangling at dagre's single-column depth,
        // which would stretch the fit bounds far below the leaf grid.
        archiveLeafIds.add(ARCHIVED_SCHED_NODE_ID)
      }
      const finishedByChallenge = groupByChallenge(finished)
      for (const challengeId of challengeIdsOf(finishedByChallenge)) {
        addChallengeNode(
          archivedChallengeNodeId(challengeId),
          ARCHIVE_NODE_ID,
          challengeId,
          finishedByChallenge.get(challengeId)!,
          { withAgents: false }
        )
      }
    }
  }

  return {
    nodes: layoutArchiveLeafGrid(
      layoutWithDagre(rawNodes, rawEdges, dims),
      dims,
      archiveLeafIds
    ),
    edges: rawEdges,
  }
}

/** Reflow the archive challenge leaves into a grid anchored right of the
 * archive root. Dagre stacks same-rank leaves into one column, which pushes
 * a large archive far outside any readable zoom; a wrapped grid keeps the
 * whole branch visible at roughly full size. */
function layoutArchiveLeafGrid(
  nodes: GraphFlowNode[],
  dims: Record<string, { width: number; height: number }>,
  leafIds: Set<string>
): GraphFlowNode[] {
  if (leafIds.size === 0) return nodes
  const root = nodes.find((node) => node.id === ARCHIVE_NODE_ID)
  const leaves = nodes.filter((node) => leafIds.has(node.id))
  if (!root) return nodes

  const GAP = 24
  const columns = Math.min(
    8,
    Math.max(1, Math.ceil(Math.sqrt(leaves.length * 0.6)))
  )
  const rows = Math.ceil(leaves.length / columns)
  // Mixed node kinds (scheduler + challenges): step by the largest so cells
  // never overlap.
  const step = leaves.reduce(
    (acc, node) => {
      const dim = dims[node.id] ?? { width: 208, height: 60 }
      return {
        width: Math.max(acc.width, dim.width),
        height: Math.max(acc.height, dim.height),
      }
    },
    { width: 0, height: 0 }
  )
  const anchorX = root.position.x + (dims[root.id]?.width ?? 176) + 48
  const anchorY = root.position.y + (dims[root.id]?.height ?? 56) / 2
  const gridHeight = rows * step.height + (rows - 1) * GAP
  return nodes.map((node) => {
    if (!leafIds.has(node.id)) return node
    const index = leaves.indexOf(node)
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      ...node,
      position: {
        x: anchorX + column * (step.width + GAP),
        y: anchorY - gridHeight / 2 + row * (step.height + GAP),
      },
    }
  })
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

function SchedulerGraphNode({ data }: NodeProps<SchedulerFlowNode>) {
  const d = data
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

function ChallengeGraphNode({ data }: NodeProps<ChallengeFlowNode>) {
  const d = data
  return (
    <GraphNodeShell className="w-52">
      <Puzzle className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight font-medium">
          {d.name}
        </span>
        <span className="block truncate text-2xs leading-tight text-muted-foreground">
          {d.category ?? "未分类"}
          {d.points != null ? ` · ${d.points} 分` : ""}
        </span>
      </span>
      <Badge size="sm" variant="secondary">
        ×{d.agentCount}
      </Badge>
    </GraphNodeShell>
  )
}

function ActiveGraphNode({ data }: NodeProps<ActiveFlowNode>) {
  const d = data
  return (
    <GraphNodeShell className="w-44">
      <Activity className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">活跃</span>
      <Badge size="sm" variant="secondary">
        ×{d.count}
      </Badge>
    </GraphNodeShell>
  )
}

function ArchiveGraphNode({ data }: NodeProps<ArchiveFlowNode>) {
  const d = data
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

function AgentGraphNode({ data }: NodeProps<AgentFlowNode>) {
  const d = data
  const { agent } = d
  const finish = agentFinishBadge(agent.status)
  return (
    <GraphNodeShell className={cn("w-52", finish && "opacity-60")}>
      <AgentStatusIcon className="[&_svg]:size-3.5" status={agent.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight">
          {agent.name ?? roleLabel(agent.role)}
        </span>
        <span className="block truncate text-2xs leading-tight text-muted-foreground">
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
  active: ActiveGraphNode,
  archive: ArchiveGraphNode,
  scheduler: SchedulerGraphNode,
  challenge: ChallengeGraphNode,
  agent: AgentGraphNode,
} satisfies NodeTypes

/** The ReactFlow canvas. Split out from AgentsGraph for provider nesting. */
function GraphCanvas({
  graph,
  graphKey,
  onActivateNode,
}: {
  graph: { nodes: GraphFlowNode[]; edges: Edge[] }
  graphKey: string
  onActivateNode: (node: GraphFlowNode) => void
}) {
  const onNodeClick = useCallback(
    (_event: ReactMouseEvent, node: GraphFlowNode) => onActivateNode(node),
    [onActivateNode]
  )

  // Enter/Space on a focused node runs the same activation as a click — RF's
  // built-in keydown only toggles selection, it never fires onNodeClick.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return
      const target = event.target
      const id =
        target instanceof HTMLElement
          ? target.closest<HTMLElement>(".react-flow__node")?.dataset.id
          : undefined
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
      // An expanded archive is a very tall single-column layout; the fit must
      // be allowed to zoom out far enough that the whole graph stays visible.
      minZoom={0.1}
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
      [...agents].toSorted(
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
    (node: GraphFlowNode) => {
      const data = node.data
      if (data.kind === "active") {
        return
      } else if (data.kind === "archive") {
        setArchiveOpen((prev) => !prev)
      } else if (data.kind === "scheduler") {
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
        <CardDescription>
          活跃与已归档的运行按题目分组，点击节点进入对应任务；归档节点可展开。
        </CardDescription>
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
