import { describe, expect, test } from "bun:test"

import {
  collectSink,
  execTimeoutMs,
} from "../../src/run/container/container-manager"

/**
 * Regression guard for the seconds→ms timeout contract. exec/capture receive a
 * timeout in seconds (bash tool schema / workspace file tools) and must hand
 * milliseconds to setTimeout. Before this helper existed the seconds value was
 * passed straight to setTimeout, so a 30s timeout fired at 30ms and every
 * "timed-out" bash call came back as "(no output)".
 */
describe("execTimeoutMs", () => {
  test("converts seconds to milliseconds", () => {
    expect(execTimeoutMs(1)).toBe(1000)
    expect(execTimeoutMs(10)).toBe(10_000)
    expect(execTimeoutMs(30)).toBe(30_000)
    expect(execTimeoutMs(120)).toBe(120_000)
  })

  test("returns undefined when no timeout applies", () => {
    expect(execTimeoutMs(undefined)).toBeUndefined()
    expect(execTimeoutMs(0)).toBeUndefined()
    expect(execTimeoutMs(-5)).toBeUndefined()
    expect(execTimeoutMs(NaN)).toBeUndefined()
  })
})

/** Collect every buffered chunk a sink received (sinks are async writables). */
async function drainSink(sink: NodeJS.WritableStream, writes: Buffer[]) {
  await new Promise<void>((resolve) => {
    for (const chunk of writes) sink.write(chunk)
    sink.end(resolve)
  })
}

/**
 * Memory-bound contract for capture(): output beyond `maxCapture` must be
 * dropped from the buffer while still counted in `bytes()` — a huge `cat` can
 * never spike host RAM, and `outputBytes`/`truncated` stay accurate.
 */
describe("collectSink", () => {
  test("buffers everything without a cap", async () => {
    const into: Buffer[] = []
    const { sink, bytes } = collectSink(into)
    await drainSink(sink, [Buffer.from("ab"), Buffer.from("cd")])
    expect(Buffer.concat(into).toString()).toBe("abcd")
    expect(bytes()).toBe(4)
  })

  test("drops bytes beyond maxCapture but counts them", async () => {
    const into: Buffer[] = []
    const { sink, bytes } = collectSink(into, 6)
    await drainSink(sink, [Buffer.from("abcdefghij")])
    expect(Buffer.concat(into).toString()).toBe("abcdef")
    expect(bytes()).toBe(10)
  })

  test("slices a chunk straddling the cap at the boundary", async () => {
    const into: Buffer[] = []
    const { sink, bytes } = collectSink(into, 5)
    await drainSink(sink, [Buffer.from("abcdef")])
    expect(Buffer.concat(into).toString()).toBe("abcde")
    expect(bytes()).toBe(6)
  })

  test("stops buffering after the cap across many chunks", async () => {
    const into: Buffer[] = []
    const { sink, bytes } = collectSink(into, 8)
    await drainSink(sink, [
      Buffer.from("aaa"),
      Buffer.from("bbb"),
      Buffer.from("ccc"),
      Buffer.from("ddd"),
    ])
    expect(Buffer.concat(into).toString()).toBe("aaabbbcc")
    expect(bytes()).toBe(12)
  })
})
