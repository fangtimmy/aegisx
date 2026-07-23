import { describe, expect, test } from "bun:test"
import type { Message } from "../../../shared"
import { fromAgentMessage, toAgentMessage, toAgentMessages } from "./convert"

describe("message convert", () => {
  test("round-trips user and notice into agent history", () => {
    const rows: Message[] = [
      {
        role: "user",
        id: "1",
        seq: 1,
        agentId: "a",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "bootstrap",
        content: "hello",
      },
      {
        role: "notice",
        id: "2",
        seq: 2,
        agentId: "a",
        createdAt: "2026-01-01T00:00:01.000Z",
        source: "child_result",
        text: "child done",
        handoff: { agentId: "c", agentName: "W", status: "completed" },
      },
    ]
    const agentMsgs = toAgentMessages(rows)
    expect(agentMsgs).toHaveLength(2)
    expect(agentMsgs[0]?.role).toBe("user")
    expect(agentMsgs[1]?.role).toBe("user")
    if (agentMsgs[1]?.role === "user") {
      expect(agentMsgs[1].content).toBe("child done")
    }
  })

  test("fromAgentMessage maps assistant", () => {
    const stored = fromAgentMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 1,
        api: "x",
        provider: "p",
        model: "m",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      } as never,
      { id: "m1", agentId: "a", seq: 3, createdAt: "t" }
    )
    expect(stored.role).toBe("assistant")
    if (stored.role === "assistant") {
      expect(stored.seq).toBe(3)
      expect(stored.content[0]).toEqual({ type: "text", text: "hi" })
    }
  })

  test("toAgentMessage assistant", () => {
    const msg = toAgentMessage({
      role: "assistant",
      id: "1",
      seq: 1,
      agentId: "a",
      createdAt: "t",
      content: [{ type: "text", text: "x" }],
      stopReason: "stop",
    })
    expect(msg.role).toBe("assistant")
  })
})
