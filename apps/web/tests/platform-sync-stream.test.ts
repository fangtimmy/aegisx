import assert from "node:assert/strict"
import test from "node:test"
import { parseSyncStreamLine } from "@/features/events/platform-sync-stream"

test("parses challenge sync progress and completion events", () => {
  assert.deepEqual(
    parseSyncStreamLine(
      JSON.stringify({
        type: "progress",
        progress: {
          remoteId: "challenge-1",
          phase: "attachment",
          message: "Downloading attachment 1/1: pwn.bin",
          name: "Remote Pwn",
          category: "pwn",
          points: 500,
          attachment: { filename: "pwn.bin", index: 1, total: 1 },
        },
      })
    ),
    {
      type: "progress",
      progress: {
        remoteId: "challenge-1",
        phase: "attachment",
        message: "Downloading attachment 1/1: pwn.bin",
        name: "Remote Pwn",
        category: "pwn",
        points: 500,
        attachment: { filename: "pwn.bin", index: 1, total: 1 },
      },
    }
  )
  assert.deepEqual(
    parseSyncStreamLine(
      JSON.stringify({
        type: "item",
        item: {
          remoteId: "challenge-1",
          status: "created",
          name: "Remote Pwn",
          category: "pwn",
          points: 500,
          attachments: [
            { filename: "pwn.bin", size: 12, status: "downloaded" },
          ],
        },
        completed: 1,
        total: 2,
      })
    ),
    {
      type: "item",
      item: {
        remoteId: "challenge-1",
        status: "created",
        name: "Remote Pwn",
        category: "pwn",
        points: 500,
        attachments: [{ filename: "pwn.bin", size: 12, status: "downloaded" }],
      },
      completed: 1,
      total: 2,
    }
  )
  assert.deepEqual(
    parseSyncStreamLine(JSON.stringify({ type: "complete", syncedAt: "now" })),
    { type: "complete", syncedAt: "now" }
  )
  assert.equal(parseSyncStreamLine("\n"), undefined)
})

test("rejects malformed challenge sync events", () => {
  assert.throws(
    () => parseSyncStreamLine(JSON.stringify({ type: "item", item: {} })),
    /无效的题目同步事件/
  )
  assert.throws(
    () => parseSyncStreamLine(JSON.stringify({ type: "unknown" })),
    /无效的题目同步事件/
  )
})
