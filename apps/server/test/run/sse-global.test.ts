import { describe, expect, test } from "bun:test"

import type { LiveEvent } from "@aegisx/shared/live-event"
import { Hono } from "hono"

import { channelMessages } from "../../src/db/schema"
import { agentAuth } from "../../src/infrastructure/agent-auth"
import { mintAgentToken } from "../../src/infrastructure/agent-credentials"
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

/** Read SSE frames with their `id:` lines until `done` holds. */
async function readFramesWithIds(
  response: Response,
  done: (seen: {
    events: Array<{ id: string | null; event: LiveEvent }>
  }) => boolean,
  timeoutMs = 1000
): Promise<{ events: Array<{ id: string | null; event: LiveEvent }> }> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: Array<{ id: string | null; event: LiveEvent }> = []
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (!done({ events })) {
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
        // A frame's data line may precede its id line — collect the whole
        // frame before pushing.
        const lines = buffer.slice(0, end).split("\n")
        let id: string | null = null
        for (const line of lines) {
          if (line.startsWith("id:")) id = line.slice(3).trim()
        }
        for (const line of lines) {
          if (line.startsWith("data:")) {
            events.push({
              id,
              event: refine<LiveEvent>(JSON.parse(line.slice(5).trim())),
            })
          }
        }
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf("\n\n")
      }
    }
  } finally {
    await reader.cancel()
  }
  return { events }
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

  test("channel frames carry the ledger row id, and Last-Event-ID replays the gap", async () => {
    const harness = makeAgentService({})
    try {
      // Two ledger rows written while "disconnected".
      for (const body of ["first", "second"]) {
        harness.db
          .insert(channelMessages)
          .values({
            channelKey: "orch:evt-1",
            authorType: "system",
            authorAgentId: null,
            authorName: "system",
            body,
            meta: "{}",
            createdAt: "2025-01-01T00:00:00Z",
          })
          .run()
      }
      const rows = harness.db
        .select({ id: channelMessages.id, body: channelMessages.body })
        .from(channelMessages)
        .orderBy(channelMessages.id)
        .all()

      // Reconnect presenting the FIRST row's id as the Last-Event-ID.
      const app = new Hono()
      app.use("*", agentAuth(harness.db))
      registerRunRoutes(app, { db: harness.db, agentService: harness.service })
      const response = await app.request("/api/stream", {
        headers: { "last-event-id": String(rows[0].id) },
      })

      expect(response.status).toBe(200)
      const { events: frames } = await readFramesWithIds(
        response,
        ({ events }) =>
          events.filter(({ event }) => event.type === "channel.message")
            .length >= 1
      )
      const replayed = frames.flatMap(({ id, event }) =>
        event.type === "channel.message" ? [{ id, message: event.message }] : []
      )
      // Only the row PAST the cursor is replayed, with its ledger id on the
      // frame (EventSource echoes it back on the next reconnect).
      expect(replayed).toHaveLength(1)
      expect(replayed[0].message.id).toBe(rows[1].id)
      expect(replayed[0].id).toBe(String(rows[1].id))
    } finally {
      await harness.close()
    }
  })

  test("non-channel frames carry NO id line — the replay cursor belongs to channel frames alone", async () => {
    const harness = makeAgentService({})
    seedAgent(harness.db, { id: "agent-1" })
    try {
      const response = await openStream(harness)
      harness.service.bus.emit("agent-1", {
        type: "agent.activity",
        agentId: "agent-1",
        activity: "retrying",
      })
      const { events: frames } = await readFramesWithIds(
        response,
        ({ events }) =>
          events.some(({ event }) => event.type === "agent.activity")
      )
      // The seed snapshot's agent.updated frames and the live activity frame
      // are session-entry/bus faces: an id: line here would let EventSource
      // echo a non-ledger cursor back as Last-Event-ID and clobber the
      // channel replay position.
      const nonChannel = frames.filter(
        ({ event }) => event.type !== "channel.message"
      )
      expect(nonChannel.length).toBeGreaterThanOrEqual(2)
      for (const { id } of nonChannel) expect(id).toBeNull()
    } finally {
      await harness.close()
    }
  })

  test("agent tokens are refused — the stream is the user face", async () => {
    const harness = makeAgentService({})
    seedAgent(harness.db, { id: "agent-1" })
    try {
      const app = new Hono()
      app.use("*", agentAuth(harness.db))
      registerRunRoutes(app, { db: harness.db, agentService: harness.service })
      const response = await app.request("/api/stream", {
        headers: { authorization: `Bearer ${mintAgentToken("agent-1")}` },
      })
      expect(response.status).toBe(403)
    } finally {
      await harness.close()
    }
  })
})
