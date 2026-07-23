import assert from "node:assert/strict"
import test from "node:test"
import type { ConversationToolExpandPrefs } from "@/api"
import {
  shouldAutoExpandTool,
  toolExpandCategory,
} from "@/features/runs/tool-expand"

const off: ConversationToolExpandPrefs = {
  fileRead: false,
  fileEdit: false,
  bash: false,
  target: false,
  flag: false,
  agent: false,
  errors: false,
}

test("classifies tools into expand categories", () => {
  assert.equal(toolExpandCategory("read"), "fileRead")
  assert.equal(toolExpandCategory("grep"), "fileRead")
  assert.equal(toolExpandCategory("write"), "fileEdit")
  assert.equal(toolExpandCategory("edit"), "fileEdit")
  assert.equal(toolExpandCategory("bash"), "bash")
  assert.equal(toolExpandCategory("start_target"), "target")
  assert.equal(toolExpandCategory("submit_flag"), "flag")
  assert.equal(toolExpandCategory("spawn_agent"), "agent")
})

test("auto-expand defaults to collapsed", () => {
  assert.equal(shouldAutoExpandTool("bash", "running", off), false)
  assert.equal(shouldAutoExpandTool("bash", "error", off), false)
  assert.equal(shouldAutoExpandTool("bash", "done", off), false)
})

test("category prefs expand only while running", () => {
  const prefs = { ...off, bash: true }
  assert.equal(shouldAutoExpandTool("bash", "running", prefs), true)
  assert.equal(shouldAutoExpandTool("bash", "done", prefs), false)
  assert.equal(shouldAutoExpandTool("read", "running", prefs), false)
})

test("errors option expands failed tools", () => {
  const prefs = { ...off, errors: true }
  assert.equal(shouldAutoExpandTool("bash", "error", prefs), true)
  assert.equal(shouldAutoExpandTool("bash", "running", prefs), false)
})
