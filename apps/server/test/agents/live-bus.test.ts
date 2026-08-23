import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@aegisx/shared"

import { createLiveBus } from "../../src/agents/live"
import { refine } from "../support"

type ToolProgressEvent = Extract<LiveEvent, { type: "tool.progress" }>

/** Narrow a LiveEvent to its tool.progress variant (the bus snapshots these). */
function asTool(event: LiveEvent): ToolProgressEvent {
  return refine<ToolProgressEvent>(event)
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
      refine<Extract<LiveEvent, { type: "agent.activity" }>>(
        bus.getActivity("a1")
      )?.activity
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

  test("forget drops the closed agents' channel snapshots only", () => {
    const bus = createLiveBus()
    bus.emit("a1", toolProgress("a1", "t1", "running", "p"))
    bus.emit("a1", {
      type: "context.updated",
      agentId: "a1",
      tokens: 10,
      contextWindow: 1000,
      percent: 1,
      cacheHitRate: null,
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    })
    bus.emit("a1", {
      type: "agent.activity",
      agentId: "a1",
      activity: "compacting",
    })
    // A second agent's snapshots must survive (only the closed one is dropped).
    bus.emit("a2", toolProgress("a2", "t2", "running", "q"))

    bus.forget(["a1"])

    expect(bus.getToolProgress("a1").length).toBe(0)
    expect(bus.getContext("a1")).toBeUndefined()
    expect(bus.getActivity("a1")).toBeUndefined()
    expect(bus.getQueue("a1")).toBeUndefined()
    // a2's snapshots are untouched.
    expect(bus.getToolProgress("a2").length).toBe(1)
    // Subscribers are not touched (they manage themselves on close).
  })
})
