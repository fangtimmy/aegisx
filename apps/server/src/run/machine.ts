import type { AgentStatus, Message, RunStatus } from "../../../shared"
import { isTerminalAgentStatus, isTerminalRunStatus } from "../../../shared"
import type {
  AgentOutcome,
  AgentRecord,
  Cmd,
  Effect,
  ReduceResult,
  RunAggregate,
} from "./types"
import { agentById, mainAgent } from "./types"

const DEFAULT_RESUME_CHILD =
  "Continue the delegated task from the current state and report your final findings."

function touchAgent(
  agent: AgentRecord,
  now: string,
  patch: Partial<AgentRecord>
): AgentRecord {
  return { ...agent, ...patch, updatedAt: now }
}

function mapAgents(
  state: RunAggregate,
  now: string,
  map: (agent: AgentRecord) => AgentRecord
): AgentRecord[] {
  return state.agents.map((agent) => {
    const next = map(agent)
    return next === agent ? agent : touchAgent(agent, now, next)
  })
}

function _nonTerminalAgents(state: RunAggregate): AgentRecord[] {
  return state.agents.filter((agent) => !isTerminalAgentStatus(agent.status))
}

function fail(
  code: "not_found" | "invalid_state" | "capacity" | "message_id_conflict",
  message: string
): ReduceResult {
  return { ok: false, code, message }
}

function ok(state: RunAggregate, effects: Effect[] = []): ReduceResult {
  return { ok: true, state, effects }
}

function withRun(
  state: RunAggregate,
  now: string,
  patch: Partial<RunAggregate>,
  agents?: AgentRecord[]
): RunAggregate {
  return {
    ...state,
    ...patch,
    agents: agents ?? state.agents,
    updatedAt: now,
  }
}

function stopNonMain(
  agents: AgentRecord[],
  mainId: string,
  now: string,
  mainPatch: Partial<AgentRecord>
): AgentRecord[] {
  return agents.map((agent) => {
    if (agent.id === mainId) {
      return touchAgent(agent, now, mainPatch)
    }
    if (isTerminalAgentStatus(agent.status)) return agent
    return touchAgent(agent, now, {
      status: "stopped",
      completedAt: now,
    })
  })
}

function pauseAllAgents(agents: AgentRecord[], now: string): AgentRecord[] {
  return agents.map((agent) => {
    if (agent.status === "running" || agent.status === "idle") {
      return touchAgent(agent, now, { status: "paused" })
    }
    return agent
  })
}

function userMessage(
  agentId: string,
  messageId: string,
  text: string,
  source: "user" | "resume" | "bootstrap",
  now: string,
  clientMessageId?: string,
  seq = 0
): Message {
  return {
    role: "user",
    id: messageId,
    seq,
    agentId,
    createdAt: now,
    source,
    content: text,
    ...(clientMessageId ? { clientMessageId } : {}),
    timestamp: Date.parse(now) || Date.now(),
  }
}

function noticeMessage(
  agentId: string,
  messageId: string,
  text: string,
  now: string,
  handoff: { agentId: string; agentName: string; status: string },
  seq = 0
): Message {
  return {
    role: "notice",
    id: messageId,
    seq,
    agentId,
    createdAt: now,
    source: "child_result",
    text,
    handoff,
    timestamp: Date.parse(now) || Date.now(),
  }
}

function childNoticeText(child: AgentRecord, outcome: AgentOutcome): string {
  const result =
    outcome.summary ??
    outcome.error ??
    child.summary ??
    child.error ??
    "No final output was produced."
  const status = outcome.status === "success" ? "completed" : "failed"
  return [
    `Background agent ${child.name} (${child.id}) ${status}.`,
    "Final output:",
    result,
  ].join("\n\n")
}

/**
 * Pure run lifecycle reducer. No I/O.
 * Capacity checks that need global agent counts are enforced by the service
 * before calling reduce (create/resume/spawn).
 */
export function reduce(state: RunAggregate | null, cmd: Cmd): ReduceResult {
  if (cmd.t === "create") {
    if (state) return fail("invalid_state", "Run already exists")
    const created: RunAggregate = {
      id: cmd.runId,
      challengeId: cmd.challengeId,
      status: "running",
      mainAgentId: cmd.mainAgentId,
      modelJson: JSON.stringify(cmd.model),
      envJson: JSON.stringify(cmd.env),
      promptJson: JSON.stringify(cmd.prompt),
      workspacePath: cmd.workspacePath,
      pendingFinishSummary: null,
      error: null,
      summary: null,
      flag: null,
      createdAt: cmd.now,
      startedAt: cmd.now,
      updatedAt: cmd.now,
      completedAt: null,
      agents: [
        {
          id: cmd.mainAgentId,
          runId: cmd.runId,
          parentAgentId: null,
          name: "Main agent",
          task: null,
          status: "running",
          summary: null,
          error: null,
          createdAt: cmd.now,
          startedAt: cmd.now,
          updatedAt: cmd.now,
          completedAt: null,
        },
      ],
    }
    const message = userMessage(
      cmd.mainAgentId,
      cmd.bootstrapMessageId,
      cmd.bootstrapText,
      "bootstrap",
      cmd.now
    )
    return ok(created, [
      { t: "insert_message", message },
      { t: "attach", agentId: cmd.mainAgentId },
      {
        t: "dispatch",
        agentId: cmd.mainAgentId,
        kind: "bootstrap",
        text: cmd.bootstrapText,
        messageId: cmd.bootstrapMessageId,
      },
    ])
  }

  if (!state) return fail("not_found", "Run not found")

  switch (cmd.t) {
    case "user_message":
      return reduceUserMessage(state, cmd)
    case "pause":
      return reducePause(state, cmd.now)
    case "resume":
      return reduceResume(state, cmd)
    case "stop":
      return reduceStop(state, cmd.now)
    case "request_finish":
      return reduceRequestFinish(state, cmd.summary)
    case "main_settled":
      return reduceMainSettled(state, cmd.outcome, cmd.now)
    case "child_settled":
      return reduceChildSettled(state, cmd)
    case "spawn":
      return reduceSpawn(state, cmd)
    case "container_failed":
      return reduceContainerFailed(state, cmd.error, cmd.now)
    case "recover_on_boot":
      return reduceRecoverOnBoot(state, cmd.now)
    default:
      return fail("invalid_state", "Unknown command")
  }
}

function reduceUserMessage(
  state: RunAggregate,
  cmd: Extract<Cmd, { t: "user_message" }>
): ReduceResult {
  if (state.status !== "running") {
    return fail("invalid_state", "Run is not running")
  }
  const main = mainAgent(state)
  if (!main) return fail("invalid_state", "Main agent is unavailable")
  if (main.status !== "running" && main.status !== "idle") {
    return fail("invalid_state", "Main agent cannot accept messages")
  }
  const agents =
    main.status === "idle"
      ? mapAgents(state, cmd.now, (agent) =>
          agent.id === main.id ? { ...agent, status: "running" } : agent
        )
      : state.agents
  const message = userMessage(
    main.id,
    cmd.messageId,
    cmd.text,
    "user",
    cmd.now,
    cmd.clientMessageId
  )
  return ok(withRun(state, cmd.now, {}, agents), [
    { t: "insert_message", message },
    {
      t: "dispatch",
      agentId: main.id,
      kind: "user",
      text: cmd.text,
      messageId: cmd.messageId,
      clientMessageId: cmd.clientMessageId,
    },
  ])
}

function reducePause(state: RunAggregate, now: string): ReduceResult {
  if (state.status !== "running") {
    return fail("invalid_state", "Run is not running")
  }
  const agents = pauseAllAgents(state.agents, now)
  return ok(withRun(state, now, { status: "paused", error: null }, agents), [
    { t: "abort_all" },
    { t: "release_all" },
  ])
}

function reduceResume(
  state: RunAggregate,
  cmd: Extract<Cmd, { t: "resume" }>
): ReduceResult {
  if (state.status !== "paused") {
    return fail("invalid_state", "Run is not paused")
  }
  const paused = state.agents.filter((agent) => agent.status === "paused")
  const main = paused.find((agent) => agent.parentAgentId === null)
  if (!main) return fail("invalid_state", "Main agent is unavailable")

  const agents = mapAgents(state, cmd.now, (agent) => {
    if (agent.status !== "paused") return agent
    return {
      ...agent,
      status: "running" as AgentStatus,
      error: null,
      completedAt: null,
    }
  })
  const next = withRun(
    state,
    cmd.now,
    { status: "running", error: null, completedAt: null },
    agents
  )
  const message = userMessage(
    main.id,
    cmd.messageId,
    cmd.text,
    "resume",
    cmd.now,
    cmd.clientMessageId
  )
  const effects: Effect[] = [
    { t: "insert_message", message },
    { t: "attach", agentId: main.id },
    {
      t: "dispatch",
      agentId: main.id,
      kind: "resume",
      text: cmd.text,
      messageId: cmd.messageId,
      clientMessageId: cmd.clientMessageId,
    },
  ]
  for (const child of paused) {
    if (child.id === main.id) continue
    effects.push({ t: "attach", agentId: child.id })
    effects.push({
      t: "dispatch",
      agentId: child.id,
      kind: "resume",
      text: DEFAULT_RESUME_CHILD,
      messageId: `${cmd.messageId}:${child.id}`,
    })
  }
  return ok(next, effects)
}

function reduceStop(state: RunAggregate, now: string): ReduceResult {
  if (isTerminalRunStatus(state.status)) {
    return fail("invalid_state", "Run is already terminal")
  }
  const agents = mapAgents(state, now, (agent) => {
    if (isTerminalAgentStatus(agent.status)) return agent
    return {
      ...agent,
      status: "stopped" as AgentStatus,
      completedAt: now,
    }
  })
  return ok(
    withRun(
      state,
      now,
      { status: "stopped", completedAt: now, pendingFinishSummary: null },
      agents
    ),
    [{ t: "abort_all" }, { t: "release_all" }]
  )
}

function reduceRequestFinish(
  state: RunAggregate,
  summary: string
): ReduceResult {
  if (state.status !== "running") {
    return fail("invalid_state", "Run is not running")
  }
  const main = mainAgent(state)
  if (!main || (main.status !== "running" && main.status !== "idle")) {
    return fail("invalid_state", "Main agent cannot finish the run")
  }
  const trimmed = summary.trim()
  if (!trimmed) return fail("invalid_state", "Finish summary is required")
  return ok(
    withRun(state, state.updatedAt, {
      pendingFinishSummary: trimmed,
    })
  )
}

function reduceMainSettled(
  state: RunAggregate,
  outcome: AgentOutcome,
  now: string
): ReduceResult {
  if (isTerminalRunStatus(state.status)) {
    return ok(state, [{ t: "release_all" }])
  }
  const main = mainAgent(state)
  if (main?.status !== "running") {
    return ok(state)
  }

  if (outcome.status === "success" && state.pendingFinishSummary) {
    const summary = state.pendingFinishSummary
    const agents = stopNonMain(state.agents, main.id, now, {
      status: "completed",
      completedAt: now,
      summary,
      error: null,
    })
    return ok(
      withRun(
        state,
        now,
        {
          status: "completed",
          completedAt: now,
          summary,
          pendingFinishSummary: null,
          error: null,
        },
        agents
      ),
      [{ t: "abort_all", exceptAgentId: main.id }, { t: "release_all" }]
    )
  }

  if (outcome.status === "success") {
    const agents = mapAgents(state, now, (agent) =>
      agent.id === main.id
        ? { ...agent, status: "idle" as AgentStatus, error: null }
        : agent
    )
    return ok(withRun(state, now, {}, agents))
  }

  // error or aborted while still marked running → fail the run
  const error = outcome.error ?? "Agent session failed"
  const agents = stopNonMain(state.agents, main.id, now, {
    status: "failed",
    completedAt: now,
    summary: outcome.summary,
    error,
  })
  return ok(
    withRun(
      state,
      now,
      {
        status: "failed",
        completedAt: now,
        error,
        pendingFinishSummary: null,
      },
      agents
    ),
    [{ t: "abort_all", exceptAgentId: main.id }, { t: "release_all" }]
  )
}

function reduceChildSettled(
  state: RunAggregate,
  cmd: Extract<Cmd, { t: "child_settled" }>
): ReduceResult {
  const child = agentById(state, cmd.agentId)
  if (!child || child.parentAgentId === null) {
    return fail("invalid_state", "Child agent not found")
  }
  if (child.status !== "running") {
    return ok(state, [{ t: "release_agent", agentId: child.id }])
  }

  const childStatus: AgentStatus =
    cmd.outcome.status === "success" ? "completed" : "failed"
  const childError =
    cmd.outcome.status === "success"
      ? null
      : (cmd.outcome.error ?? "Agent session failed")

  let agents = mapAgents(state, cmd.now, (agent) => {
    if (agent.id !== child.id) return agent
    return {
      ...agent,
      status: childStatus,
      completedAt: cmd.now,
      summary: cmd.outcome.summary,
      error: childError,
    }
  })

  const effects: Effect[] = [{ t: "release_agent", agentId: child.id }]

  if (state.status !== "running") {
    return ok(withRun(state, cmd.now, {}, agents), effects)
  }

  const main = mainAgent({ ...state, agents })
  if (!main || (main.status !== "running" && main.status !== "idle")) {
    return ok(withRun(state, cmd.now, {}, agents), effects)
  }

  const finished = agentById({ ...state, agents }, child.id) as AgentRecord
  const text = childNoticeText(finished, cmd.outcome)
  const handoff = {
    agentId: finished.id,
    agentName: finished.name,
    status: childStatus,
  }
  const message = noticeMessage(
    main.id,
    cmd.noticeMessageId,
    text,
    cmd.now,
    handoff
  )
  effects.push({ t: "insert_message", message })

  if (main.status === "idle") {
    agents = mapAgents({ ...state, agents }, cmd.now, (agent) =>
      agent.id === main.id
        ? { ...agent, status: "running" as AgentStatus }
        : agent
    )
    effects.push({
      t: "dispatch",
      agentId: main.id,
      kind: "notice",
      text,
      messageId: cmd.noticeMessageId,
      handoff,
    })
  } else {
    // main running: still deliver notice into message log; runtime may pick up
    // on next turn. Also dispatch so live session injects if attached.
    effects.push({
      t: "dispatch",
      agentId: main.id,
      kind: "notice",
      text,
      messageId: cmd.noticeMessageId,
      handoff,
    })
  }

  return ok(withRun(state, cmd.now, {}, agents), effects)
}

function reduceSpawn(
  state: RunAggregate,
  cmd: Extract<Cmd, { t: "spawn" }>
): ReduceResult {
  if (state.status !== "running") {
    return fail("invalid_state", "Run is not running")
  }
  const parent = agentById(state, cmd.parentId)
  if (!parent || parent.parentAgentId !== null) {
    return fail("invalid_state", "Only the main agent can spawn children")
  }
  if (parent.status !== "running" && parent.status !== "idle") {
    return fail("invalid_state", "Main agent cannot spawn right now")
  }
  if (state.agents.some((agent) => agent.id === cmd.agentId)) {
    return fail("invalid_state", "Agent id already exists")
  }

  const child: AgentRecord = {
    id: cmd.agentId,
    runId: state.id,
    parentAgentId: parent.id,
    name: cmd.name,
    task: cmd.task,
    status: "running",
    summary: null,
    error: null,
    createdAt: cmd.now,
    startedAt: cmd.now,
    updatedAt: cmd.now,
    completedAt: null,
  }
  const agents = [...state.agents, child]
  const message = userMessage(
    cmd.agentId,
    cmd.taskMessageId,
    cmd.task,
    "bootstrap",
    cmd.now
  )
  return ok(withRun(state, cmd.now, {}, agents), [
    { t: "insert_message", message },
    { t: "attach", agentId: cmd.agentId },
    {
      t: "dispatch",
      agentId: cmd.agentId,
      kind: "bootstrap",
      text: cmd.task,
      messageId: cmd.taskMessageId,
    },
  ])
}

function reduceContainerFailed(
  state: RunAggregate,
  error: string,
  now: string
): ReduceResult {
  if (state.status !== "running") {
    return fail("invalid_state", "Run is not running")
  }
  const agents = pauseAllAgents(state.agents, now)
  return ok(withRun(state, now, { status: "paused", error }, agents), [
    { t: "abort_all" },
    { t: "release_all" },
  ])
}

function reduceRecoverOnBoot(state: RunAggregate, now: string): ReduceResult {
  if (state.status !== "running") {
    return ok(state)
  }

  if (state.pendingFinishSummary) {
    const main = mainAgent(state)
    if (!main) return fail("invalid_state", "Main agent is unavailable")
    const summary = state.pendingFinishSummary
    const agents = stopNonMain(state.agents, main.id, now, {
      status: "completed",
      completedAt: now,
      summary,
      error: null,
    })
    return ok(
      withRun(
        state,
        now,
        {
          status: "completed",
          completedAt: now,
          summary,
          pendingFinishSummary: null,
          error: null,
        },
        agents
      ),
      [{ t: "release_all" }]
    )
  }

  const agents = pauseAllAgents(state.agents, now)
  return ok(
    withRun(
      state,
      now,
      {
        status: "paused",
        error: state.error ?? "Interrupted by service restart",
      },
      agents
    ),
    [{ t: "release_all" }]
  )
}

export function activeAgentCount(state: RunAggregate): number {
  return state.agents.filter(
    (agent) => agent.status === "running" || agent.status === "idle"
  ).length
}

export function pausedAgentCount(state: RunAggregate): number {
  return state.agents.filter((agent) => agent.status === "paused").length
}

export type { RunStatus }
