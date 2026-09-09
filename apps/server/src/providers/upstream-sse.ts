import { isRecord } from "@aegisx/shared"

import { optRecord } from "../lib/guards"

export type UpstreamApi = "anthropic" | "openai" | "responses"

type TestUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Merge a partial usage readout into the accumulator (later events refine
 * earlier ones, e.g. anthropic message_delta's final output_tokens). */
function mergeUsage(
  usage: TestUsage | undefined,
  patch: Partial<TestUsage>
): TestUsage {
  return {
    input: patch.input ?? usage?.input ?? 0,
    output: patch.output ?? usage?.output ?? 0,
    cacheRead: patch.cacheRead ?? usage?.cacheRead ?? 0,
    cacheWrite: patch.cacheWrite ?? usage?.cacheWrite ?? 0,
  }
}

/** Interpret one upstream SSE `data:` payload for the test proxy — return
 * the text delta (if any), the refined usage accumulator, and whether this
 * payload is a terminal frame (`[DONE]` handled by the caller). */
function handleUpstreamEvent(
  api: UpstreamApi,
  raw: string,
  usage: TestUsage | undefined
): { usage: TestUsage | undefined; delta: string; stop?: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { usage, delta: "" }
  }
  if (!isRecord(parsed)) return { usage, delta: "" }
  const event = parsed

  if (api === "anthropic") {
    if (event.type === "content_block_delta") {
      const delta = optRecord(event.delta)
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { usage, delta: delta.text }
      }
    } else if (event.type === "message_stop") {
      return { usage, delta: "", stop: true }
    } else if (event.type === "message_start") {
      const u = optRecord(optRecord(event.message)?.usage)
      if (u) {
        usage = mergeUsage(usage, {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
        })
      }
    } else if (event.type === "message_delta") {
      const u = optRecord(event.usage)
      if (u) usage = mergeUsage(usage, { output: num(u.output_tokens) })
    }
    return { usage, delta: "" }
  }

  if (api === "openai") {
    const choices = Array.isArray(event.choices) ? event.choices : []
    const delta = optRecord(optRecord(choices[0])?.delta)
    const text =
      typeof delta?.content === "string" && delta.content ? delta.content : ""
    const u = optRecord(event.usage)
    if (u) {
      const details = optRecord(u.prompt_tokens_details)
      usage = mergeUsage(usage, {
        input: num(u.prompt_tokens),
        output: num(u.completion_tokens),
        cacheRead: num(details?.cached_tokens),
      })
    }
    return { usage, delta: text }
  }

  if (event.type === "response.output_text.delta") {
    if (typeof event.delta === "string" && event.delta)
      return { usage, delta: event.delta }
  } else if (event.type === "response.completed") {
    const u = optRecord(optRecord(event.response)?.usage)
    if (u) {
      const details = optRecord(u.input_tokens_details)
      usage = mergeUsage(usage, {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(details?.cached_tokens),
      })
    }
    return { usage, delta: "", stop: true }
  }
  return { usage, delta: "" }
}

/** Read an upstream SSE body (text/event-stream), invoking `onDelta` per
 * text chunk and returning the final token usage when the stream reports
 * one, plus whether a terminal frame was seen (OpenAI `[DONE]`, anthropic
 * `message_stop`, responses `response.completed`). Minimal framing: splits
 * events on blank lines, joins multi-line `data:` fields. */
export async function pumpUpstreamSse(
  body: ReadableStream<Uint8Array>,
  api: UpstreamApi,
  onDelta: (text: string) => Promise<void> | void,
  onChunk?: () => void
): Promise<{ usage: TestUsage | undefined; terminated: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: TestUsage | undefined
  let terminated = false

  const drainBlock = async (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data) return
    if (data === "[DONE]") {
      terminated = true
      return
    }
    const result = handleUpstreamEvent(api, data, usage)
    usage = result.usage
    if (result.stop) terminated = true
    if (result.delta) await onDelta(result.delta)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk?.()
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(
      /\r\n/g,
      "\n"
    )
    let index: number
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      await drainBlock(block)
    }
  }
  if (buffer.trim()) await drainBlock(buffer.replace(/\r/g, ""))
  return { usage, terminated }
}
