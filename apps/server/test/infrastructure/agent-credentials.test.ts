import { afterEach, describe, expect, setSystemTime, test } from "bun:test"

import {
  AGENT_TOKEN_TTL_SEC,
  mintAgentToken,
  verifyAgentToken,
} from "../../src/infrastructure/agent-credentials"

const t0 = Date.parse("2026-01-01T00:00:00Z")

afterEach(() => {
  setSystemTime()
})

describe("agent credentials (short-lived minted tokens)", () => {
  test("mint → verify roundtrip restores the agent id", () => {
    setSystemTime(t0)
    expect(verifyAgentToken(mintAgentToken("agent-abc"))).toEqual({
      agentId: "agent-abc",
    })
  })

  test("each mint embeds the current time — later mints differ and verify independently", () => {
    setSystemTime(t0)
    const a = mintAgentToken("agent-1")
    setSystemTime(t0 + 5_000)
    const b = mintAgentToken("agent-1")
    expect(b).not.toBe(a)
    expect(verifyAgentToken(a)).toEqual({ agentId: "agent-1" })
    expect(verifyAgentToken(b)).toEqual({ agentId: "agent-1" })
  })

  test("an expired token is rejected", () => {
    setSystemTime(t0)
    const token = mintAgentToken("agent-1")
    // Still valid just inside the TTL…
    setSystemTime(t0 + (AGENT_TOKEN_TTL_SEC - 1) * 1000)
    expect(verifyAgentToken(token)).toEqual({ agentId: "agent-1" })
    // …and dead one second past it.
    setSystemTime(t0 + (AGENT_TOKEN_TTL_SEC + 1) * 1000)
    expect(verifyAgentToken(token)).toBeNull()
  })

  test("a tampered payload or signature is rejected", () => {
    setSystemTime(t0)
    const token = mintAgentToken("agent-1")
    const [body, mac] = token.split(".")
    // Payload swapped for another agent's id: the HMAC no longer matches.
    const forgedBody = Buffer.from(
      JSON.stringify({ agentId: "agent-2", exp: t0 / 1000 + 60 })
    ).toString("base64url")
    expect(verifyAgentToken(`${forgedBody}.${mac}`)).toBeNull()
    // Signature flipped.
    expect(verifyAgentToken(`${body}.${mac.slice(0, -2)}aa`)).toBeNull()
    // Structural garbage.
    expect(verifyAgentToken("garbage")).toBeNull()
    expect(verifyAgentToken("a.b")).toBeNull()
  })

  test("tokens are agent-scoped: one agent's token never verifies as another", () => {
    setSystemTime(t0)
    expect(verifyAgentToken(mintAgentToken("agent-A"))).toEqual({
      agentId: "agent-A",
    })
  })
})
