import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"

import Docker from "dockerode"

import { type Clock, createFakeClock } from "../../src/run/clock"
import {
  collectSink,
  createContainerManager,
  execTimeoutMs,
  type DockerLike,
} from "../../src/run/container/container-manager"
import { refine } from "../support"

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

/** Event-loop yield with no timed wait (lets stream handlers attach / data
 * flow before the next step). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

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

/**
 * One docker multiplexed protocol frame: 8-byte header (stream type — 1
 * stdout, 2 stderr — plus BE payload length) followed by the payload. Feeding
 * these through the hijacked stream exercises the real dockerode demuxer.
 */
function frame(streamType: 1 | 2, payload: string): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt8(streamType, 0)
  header.writeUInt32BE(Buffer.byteLength(payload), 4)
  return Buffer.concat([header, Buffer.from(payload)])
}

/** Real dockerode modem, so the tests exercise the actual demuxer. */
const dockerModem = new Docker().modem

/**
 * Fake exec world for runHijacked: `exec.start` hands back a PassThrough the
 * test drives (write frames, end, destroy), `inspect` is scripted per test,
 * and demux delegates to the real dockerode modem so the frame protocol itself
 * stays under test. Every test must `await hijacked` then yield once more so
 * runHijacked has attached demux + end/close/error handlers before the stream
 * is driven.
 */
function fakeDocker(
  behavior: {
    inspect?: () => { Running?: boolean; ExitCode?: number | null }
    /** Daemon-wide container inventory for the `list` prefix scan. */
    names?: string[]
    volumes?: Map<string, boolean>
  } = {},
  /** Inject a fake clock to drive exec timeouts / poll backoffs
   * deterministically (see the timeout + pollExitCode tests). */
  clock?: Clock
): {
  manager: ReturnType<typeof createContainerManager>
  stream: PassThrough
  hijacked: Promise<void>
  volumes: Map<string, boolean>
} {
  const stream = new PassThrough()
  let hijack!: () => void
  const hijacked = new Promise<void>((resolve) => (hijack = resolve))
  const volumes = behavior.volumes ?? new Map<string, boolean>()
  const docker: DockerLike = {
    getContainer: () => ({
      exec: async () => ({
        start: async () => {
          hijack()
          return stream
        },
        inspect: async () =>
          behavior.inspect?.() ?? { Running: false, ExitCode: 0 },
      }),
      inspect: async () => ({ State: { Running: false } }),
      remove: async () => undefined,
      kill: async () => undefined,
      putArchive: async () => undefined,
    }),
    createContainer: async () => ({ id: "fake", start: async () => undefined }),
    listContainers: async ({ filters }) => {
      const wanted = refine<{ name?: string[] }>(JSON.parse(filters ?? "{}"))
      const prefix = wanted.name?.[0] ?? ""
      return (behavior.names ?? [])
        .filter((name) => name.includes(prefix))
        .map((Id) => ({ Id, Names: [`/${Id}`] }))
    },
    getVolume: (name: string) => ({
      remove: async () => {
        if (!volumes.get(name)) throw new Error("no such volume")
      },
    }),
    modem: {
      demuxStream: (source, out, err) =>
        dockerModem.demuxStream(source, out, err),
    },
  }
  return {
    manager: createContainerManager({ ...(clock ? { clock } : {}), docker }),
    stream,
    hijacked,
    volumes,
  }
}

/**
 * Real AbortSignal with abort-listener counting patched on. Bun's AbortSignal
 * exposes no listenerCount, and locking the listener-leak fix needs to observe
 * that runHijacked removed its abort listener once the run finished.
 */
function countingSignal(): {
  controller: AbortController
  signal: AbortSignal
  listenerCount: () => number
} {
  const controller = new AbortController()
  let count = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
    if (args[0] === "abort") count++
    add(...args)
  }
  controller.signal.removeEventListener = (
    ...args: Parameters<typeof remove>
  ) => {
    if (args[0] === "abort") count--
    remove(...args)
  }
  return { controller, signal: controller.signal, listenerCount: () => count }
}

describe("runHijacked", () => {
  test("normal completion resolves exit code, delivers bytes, leaves no abort listener", async () => {
    const { manager, stream, hijacked } = fakeDocker({
      inspect: () => ({ Running: false, ExitCode: 7 }),
    })
    const chunks: Buffer[] = []
    const { signal, listenerCount } = countingSignal()
    const pending = manager.exec("box", "echo hi", {
      onData: (chunk) => chunks.push(chunk),
      signal,
    })
    await hijacked
    await Bun.sleep(1)
    stream.write(frame(1, "hello"))
    stream.write(frame(2, " oops"))
    stream.end()
    expect(await pending).toEqual({
      exitCode: 7,
      timedOut: false,
      aborted: false,
    })
    expect(Buffer.concat(chunks).toString()).toBe("hello oops")
    expect(listenerCount()).toBe(0)
  })

  test("hijacked stream error mid-flight rejects the exec promise", async () => {
    const { manager, stream, hijacked } = fakeDocker()
    const pending = manager.exec("box", "echo hi", { onData: () => {} })
    await hijacked
    await Bun.sleep(1)
    stream.destroy(new Error("hijack kaboom"))
    await expect(pending).rejects.toThrow("hijack kaboom")
  })

  test("timeout while streaming resolves null exit code, keeps pre-timeout bytes, destroys stream", async () => {
    const clock = createFakeClock()
    const { manager, stream, hijacked } = fakeDocker(
      {
        inspect: () => ({ Running: false, ExitCode: 0 }),
      },
      clock
    )
    const chunks: Buffer[] = []
    const pending = manager.exec("box", "yes", {
      onData: (chunk) => chunks.push(chunk),
      timeout: 0.05,
    })
    await hijacked
    await tick()
    stream.write(frame(1, "pre-timeout"))
    await tick()
    // The 50ms exec timeout fires by advancing the fake clock — no real wait.
    clock.advance(50)
    expect(await pending).toEqual({
      exitCode: null,
      timedOut: true,
      aborted: false,
    })
    expect(Buffer.concat(chunks).toString()).toBe("pre-timeout")
    expect(stream.destroyed).toBe(true)
  })

  test("abort after start resolves aborted, destroys stream, removes abort listener", async () => {
    const { manager, stream, hijacked } = fakeDocker({
      inspect: () => ({ Running: false, ExitCode: 0 }),
    })
    const { controller, signal, listenerCount } = countingSignal()
    const pending = manager.exec("box", "sleep 100", {
      onData: () => {},
      signal,
    })
    await hijacked
    await Bun.sleep(1)
    controller.abort()
    expect(await pending).toEqual({
      exitCode: 0,
      timedOut: false,
      aborted: true,
    })
    expect(stream.destroyed).toBe(true)
    expect(listenerCount()).toBe(0)
  })

  test("pollExitCode falls back to final inspect ExitCode while daemon keeps reporting Running", async () => {
    let inspectCalls = 0
    const clock = createFakeClock()
    const { manager, stream, hijacked } = fakeDocker(
      {
        inspect: () => {
          inspectCalls++
          return inspectCalls <= 10
            ? { Running: true, ExitCode: null }
            : { Running: true, ExitCode: 5 }
        },
      },
      clock
    )
    const pending = manager.exec("box", "true", { onData: () => {} })
    await hijacked
    await tick()
    stream.end()
    // Let the stream 'end' reach runHijacked so the first poll inspect ran
    // and armed its 30ms backoff.
    await tick()
    // Release each poll backoff by advancing the fake clock — ten virtual
    // backoffs instead of 300ms real time. The loop ends when the poll
    // chain stops scheduling backoffs (final inspect reached).
    while (clock.pendingCount() > 0) {
      clock.advance(30)
      await tick()
    }
    const result = await pending
    expect(result.exitCode).toBe(5)
    expect(inspectCalls).toBe(11)
  })
})

describe("capture", () => {
  test("demuxes stdout and stderr frames into separate buffers", async () => {
    const { manager, stream, hijacked } = fakeDocker({
      inspect: () => ({ Running: false, ExitCode: 0 }),
    })
    const pending = manager.capture("box", "ls")
    await hijacked
    await Bun.sleep(1)
    stream.write(frame(1, "OUT-"))
    stream.write(frame(2, "ERR"))
    stream.write(frame(1, "1"))
    stream.end()
    const result = await pending
    expect(result.stdout.toString()).toBe("OUT-1")
    expect(result.stderr).toBe("ERR")
    expect(result.exitCode).toBe(0)
  })
})

describe("sandbox bookkeeping (boot sweep + cache volume)", () => {
  test("list returns names under the prefix, demoting docker's leading slash", async () => {
    const { manager } = fakeDocker({
      names: [
        "aegisx-agent-aaaa",
        "aegisx-agent-bbbb",
        "aegisx-orch-cccc",
        "other-box",
      ],
    })
    expect(await manager.list("aegisx-agent-")).toEqual([
      "aegisx-agent-aaaa",
      "aegisx-agent-bbbb",
    ])
    expect(await manager.list("aegisx-orch-")).toEqual(["aegisx-orch-cccc"])
    expect(await manager.list("aegisx-nope-")).toEqual([])
  })

  test("removeVolume deletes an existing volume and tolerates a missing one", async () => {
    const volumes = new Map([["aegisx-ch-cache-1", true]])
    const { manager } = fakeDocker({ volumes })
    await manager.removeVolume("aegisx-ch-cache-1")
    // Best-effort semantics: a 404 resolves instead of throwing.
    await manager.removeVolume("aegisx-ch-cache-gone")
  })
})
