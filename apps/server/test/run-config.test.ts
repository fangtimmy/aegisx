import { expect, test } from "bun:test"
import {
  parseEnvironment,
  parseModelConfig,
  parsePromptConfig,
  parseRuntimeSnapshot,
} from "../src/run-config"

test("parses run configuration with conservative fallbacks", () => {
  expect(parseEnvironment("not-json")).toEqual({ type: "local" })
  expect(
    parseEnvironment(
      JSON.stringify({
        type: "container",
        image: "aegis/solve:kali",
        cpus: 2,
        memoryMb: 1024,
        pidsLimit: 128,
      })
    )
  ).toEqual({
    type: "container",
    image: "aegis/solve:kali",
    cpus: 2,
    memoryMb: 1024,
    pidsLimit: 128,
  })
  expect(parseModelConfig(JSON.stringify({ thinkingLevel: "high" }))).toEqual({
    provider: "",
    modelId: "",
    thinkingLevel: "high",
  })
})

test("validates persisted prompt context and runtime tools", () => {
  const prompt = parsePromptConfig(
    JSON.stringify({
      mainSystemPromptTemplate: "hello",
      context: { agent: { role: "invalid" } },
    })
  )
  expect(prompt.mainSystemPromptTemplate).toBe("hello")
  expect(prompt.context).toBeUndefined()

  const snapshot = JSON.stringify({
    capturedAt: "2026-07-20T00:00:00.000Z",
    systemPrompt: "solve",
    cwd: "$WORKSPACE",
    model: {
      provider: "faux",
      modelId: "faux-1",
      thinkingLevel: "high",
    },
    tools: [
      {
        name: "bash",
        description: "Run a command",
        parameters: {},
        promptGuidelines: ["Keep output bounded"],
      },
    ],
  })
  expect(parseRuntimeSnapshot(snapshot)?.model.thinkingLevel).toBe("high")
  expect(
    parseRuntimeSnapshot(
      JSON.stringify({
        capturedAt: "now",
        systemPrompt: "solve",
        cwd: "$WORKSPACE",
        model: { provider: "faux", modelId: "faux-1" },
        tools: [{ name: "bash" }],
      })
    )
  ).toBeNull()
})
