import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@aegisx/shared/live-event"
import { Hono } from "hono"

import { agentAuth } from "../../src/infrastructure/agent-auth"
import { registerRunRoutes } from "../../src/run/routes"
import { makeAgentService, seedAgent } from "../helpers"
import { refine } from "../support"

/** Read SSE `data:` frames off the response until `done` holds (or the
 * deadline passes), then close the stream. */
async function readFrames(
  response: Response,
  done: (events: LiveEvent[]) => boolean,
  timeoutMs = 1000
): Promise<LiveEvent[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: LiveEvent[] = []
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (!done(events)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(resolve, remaining)),
      ])
      if (!chunk || chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let end = buffer.indexOf("\n\n")
      while (end !== -1) {
        for (const line of buffer.slice(0, end).split("\n")) {
          if (line.startsWith("data:")) {
            events.push(refine<LiveEvent>(JSON.parse(line.slice(5).trim())))
          }
        }
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf("\n\n")
      }
    }
  } finally {
    await reader.cancel()
  }
  return events
}

function activities(events: LiveEvent[]) {
  return events.filter((event) => event.type === "agent.activity")
}

function openStream(harness: ReturnType<typeof makeAgentService>) {
  const app = new Hono()
  app.use("*", agentAuth(harness.db))
  registerRunRoutes(app, { db: harness.db, agentService: harness.service })
  return app.request("/api/stream")
}

describe("GET /api/stream (multiplexed live stream)", () => {
  test("one connection carries every agent's events at once", async () => {
    const harness = makeAgentService({})
    seedAgent(harness.db, { id: "agent-1" })
    seedAgent(harness.db, { id: "agent-2" })
    try {
      const response = await openStream(harness)
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream"
      )

      harness.service.bus.emit("agent-1", {
        type: "agent.activity",
        agentId: "agent-1",
        activity: "retrying",
        attempt: 2,
        maxAttempts: 5,
      })
      harness.service.bus.emit("agent-2", {
        type: "agent.activity",
        agentId: "agent-2",
        activity: "compacting",
        reason: "threshold",
      })

      const events = await readFrames(
        response,
        (seen) => activities(seen).length >= 2
      )
      expect(activities(events).map((event) => event.agentId)).toEqual([
        "agent-1",
        "agent-2",
      ])
    } finally {
      await harness.close()
    }
  })

  test("channel messages ride the same connection", async () => {
    const harness = makeAgentService({})
    seedAgent(harness.db, { id: "agent-1" })
    try {
      const response = await openStream(harness)
      harness.service.bus.emit("evt-1", {
        type: "channel.message",
        message: {
          id: 7,
          channelKey: "team:ch-1",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorName: "solver",
          body: "hi",
          meta: {},
          createdAt: "2025-01-01T00:00:00Z",
          files: [],
        },
      })

      const events = await readFrames(response, (seen) =>
        seen.some((event) => event.type === "channel.message")
      )
      const message = events.find((event) => event.type === "channel.message")
      expect(message?.message.channelKey).toBe("team:ch-1")
    } finally {
      await harness.close()
    }
  })

  test("agent tokens are refused — the stream is the user face", async () => {
    const harness = makeAgentService({})
    seedAgent(harness.db, { id: "agent-1", token: "tok-agent-1" })
    try {
      const app = new Hono()
      app.use("*", agentAuth(harness.db))
      registerRunRoutes(app, { db: harness.db, agentService: harness.service })
      const response = await app.request("/api/stream", {
        headers: { authorization: "Bearer tok-agent-1" },
      })
      expect(response.status).toBe(403)
    } finally {
      await harness.close()
    }
  })
})
