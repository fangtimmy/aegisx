import { afterEach, expect, test } from "bun:test"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { defaultSettings } from "../../../shared"
import {
  clearToolTerminals,
  createToolTimeoutResolver,
  getToolTerminal,
  manageAgentTools,
  resolveToolTimeoutMs,
} from "../../src/agent/managed-tools"

afterEach(() => {
  clearToolTerminals("agent")
})

function hangingTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => new Promise(() => undefined),
  }
}

test("times out platform tools and records terminal state in memory", async () => {
  const tools = manageAgentTools(
    "agent",
    [hangingTool("start_target"), hangingTool("submit_flag")],
    (name) => (name === "start_target" ? 20 : 30)
  )

  await expect(tools[0].execute("start-call", {}, undefined)).rejects.toThrow(
    "start_target timed out after 1 seconds"
  )
  await expect(tools[1].execute("submit-call", {}, undefined)).rejects.toThrow(
    "submit_flag timed out after 1 seconds"
  )

  expect(getToolTerminal("agent", "start-call")).toMatchObject({
    toolName: "start_target",
    terminal: "timed_out",
  })
  expect(getToolTerminal("agent", "submit-call")).toMatchObject({
    toolName: "submit_flag",
    terminal: "timed_out",
  })
})

test("cancels a tool even when its promise ignores abort", async () => {
  const [tool] = manageAgentTools("agent", [hangingTool("bash")], () => 10_000)
  const controller = new AbortController()
  const executing = tool.execute("cancel-call", {}, controller.signal)

  controller.abort()
  await expect(executing).rejects.toThrow("bash was cancelled")
  expect(getToolTerminal("agent", "cancel-call")).toMatchObject({
    terminal: "cancelled",
    terminalMessage: "bash was cancelled",
  })
})

test("resolveToolTimeoutMs honors settings overrides and the bash arg budget", () => {
  const settings = {
    ...defaultSettings(),
    "tools.defaultTimeoutMs": 30_000,
    "tools.timeout.bash": 120_000,
    "tools.timeout.submit_flag": 90_000,
  }
  expect(resolveToolTimeoutMs("read", {}, settings)).toBe(30_000)
  expect(resolveToolTimeoutMs("bash", {}, settings)).toBe(120_000)
  expect(resolveToolTimeoutMs("submit_flag", {}, settings)).toBe(90_000)
  expect(resolveToolTimeoutMs("bash", { timeout: 10 }, settings)).toBe(11_000)
  const resolve = createToolTimeoutResolver(() => settings)
  expect(resolve("bash", {})).toBe(120_000)
})
