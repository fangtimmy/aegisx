import type { AgentOutcome, DispatchKind } from "./types"

/**
 * Port between run service and agent execution.
 * Phase 2 uses a fake; Phase 3 wires pi-agent.
 */
export type RuntimePort = {
  attach(runId: string, agentId: string): Promise<void> | void
  dispatch(input: {
    runId: string
    agentId: string
    kind: DispatchKind
    text: string
    messageId: string
    clientMessageId?: string
    handoff?: { agentId: string; agentName: string; status: string }
  }): void
  abort(runId: string, exceptAgentId?: string): Promise<void> | void
  release(agentId: string): void
  releaseRun(runId: string): Promise<void> | void
  /**
   * Optional: test hook — register what happens when a turn is "done".
   * Real runtime calls service.onSettled instead.
   */
}

export type SettledHandler = (
  runId: string,
  agentId: string,
  outcome: AgentOutcome
) => void | Promise<void>

/** In-memory fake for Phase 2 tests. */
export function createFakeRuntime(options?: {
  onAttach?: (runId: string, agentId: string) => void
  onDispatch?: (input: {
    runId: string
    agentId: string
    kind: DispatchKind
    text: string
    messageId: string
  }) => void
}): RuntimePort & {
  attached: Set<string>
  dispatches: Array<{
    runId: string
    agentId: string
    kind: DispatchKind
    text: string
    messageId: string
  }>
  aborted: string[]
  released: string[]
} {
  const attached = new Set<string>()
  const dispatches: Array<{
    runId: string
    agentId: string
    kind: DispatchKind
    text: string
    messageId: string
  }> = []
  const aborted: string[] = []
  const released: string[] = []

  return {
    attached,
    dispatches,
    aborted,
    released,
    attach(runId, agentId) {
      attached.add(agentId)
      options?.onAttach?.(runId, agentId)
    },
    dispatch(input) {
      dispatches.push({
        runId: input.runId,
        agentId: input.agentId,
        kind: input.kind,
        text: input.text,
        messageId: input.messageId,
      })
      options?.onDispatch?.(input)
    },
    abort(runId) {
      aborted.push(runId)
    },
    release(agentId) {
      attached.delete(agentId)
      released.push(agentId)
    },
    releaseRun(runId) {
      for (const id of [...attached]) {
        // cannot know run mapping without tracking — release all for tests
        void runId
        attached.delete(id)
        released.push(id)
      }
    },
  }
}
