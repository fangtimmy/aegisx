import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@aegisx/shared"

import { createLiveBus } from "../../src/agents/live"

type ToolProgressEvent = Extract<LiveEvent, { type: "tool.progress" }>

/** Narrow a LiveEvent to its tool.progress variant (the bus snapshots these). */
function asTool(event: LiveEvent): ToolProgressEvent {
  return event as ToolProgressEvent
}

/** Build a tool.progress event with the fields the bus snapshots on. */
function toolProgress(
  agentId: string,
  toolCallId: string,
  status: "running" | "done" | "error",
  result?: unknown
): LiveEvent {
  return {
    type: "tool.progress",
    agentId,
    toolCallId,
    revision: 1,
    toolName: "bash",
    args: { command: "echo hi" },
    ...(result !== undefined ? { result } : {}),
    status,
  }
}

describe("createLiveBus ephemeral snapshots", () => {
  test("snapshots a running tool and replays it via getToolProgress", () => {
    const bus = createLiveBus()
    bus.emit("run-1", toolProgress("a1", "t1", "running", "partial"))
    const replayed = bus.getToolProgress("a1")
    expect(replayed.length).toBe(1)
    expect(asTool(replayed[0]).toolCallId).toBe("t1")
    // unrelated agent sees nothing
    expect(bus.getToolProgress("a2").length).toBe(0)
  })

  test("a running tool's latest partial result overwrites the prior snapshot", () => {
    const bus = createLiveBus()
    bus.emit("run-1", toolProgress("a1", "t1", "running", "first"))
    bus.emit("run-1", toolProgress("a1", "t1", "running", "second"))
    const replayed = bus.getToolProgress("a1")
    expect(replayed.length).toBe(1)
    expect(asTool(replayed[0]).result).toBe("second")
  })

  test("done / error clears the snapshot (tool no longer in flight)", () => {
    const bus = createLiveBus()
    bus.emit("run-1", toolProgress("a1", "t1", "running", "partial"))
    expect(bus.getToolProgress("a1").length).toBe(1)
    bus.emit("run-1", toolProgress("a1", "t1", "done", "final"))
    expect(bus.getToolProgress("a1").length).toBe(0)
    // a fresh running tool re-populates
    bus.emit("run-1", toolProgress("a1", "t2", "running", "p"))
    expect(bus.getToolProgress("a1").length).toBe(1)
  })

  test("keeps sibling running tools when one finishes", () => {
    const bus = createLiveBus()
    bus.emit("run-1", toolProgress("a1", "t1", "running", "p1"))
    bus.emit("run-1", toolProgress("a1", "t2", "running", "p2"))
    bus.emit("run-1", toolProgress("a1", "t1", "done"))
    const replayed = bus.getToolProgress("a1")
    expect(replayed.length).toBe(1)
    expect(asTool(replayed[0]).toolCallId).toBe("t2")
  })

  test("activity snapshot: non-null upserts, null clears", () => {
    const bus = createLiveBus()
    expect(bus.getActivity("a1")).toBeUndefined()
    bus.emit("run-1", {
      type: "agent.activity",
      agentId: "a1",
      activity: "compacting",
      reason: "threshold",
    })
    expect(
      (bus.getActivity("a1") as Extract<LiveEvent, { type: "agent.activity" }>)
        ?.activity
    ).toBe("compacting")
    bus.emit("run-1", { type: "agent.activity", agentId: "a1", activity: null })
    expect(bus.getActivity("a1")).toBeUndefined()
  })

  test("close clears all snapshots", () => {
    const bus = createLiveBus()
    bus.emit("run-1", toolProgress("a1", "t1", "running", "p"))
    bus.emit("run-1", {
      type: "context.updated",
      agentId: "a1",
      tokens: 10,
      contextWindow: 1000,
      percent: 1,
      cacheHitRate: null,
      totals: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
    })
    bus.close()
    expect(bus.getToolProgress("a1").length).toBe(0)
    expect(bus.getContext("a1")).toBeUndefined()
  })
})
