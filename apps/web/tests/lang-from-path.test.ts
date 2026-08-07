import { expect, test } from "bun:test"

import { langFromPath } from "../src/lib/lang-from-path"

test("maps common extensions", () => {
  expect(langFromPath("solve.py")).toBe("python")
  expect(langFromPath("src/app.tsx")).toBe("tsx")
  expect(langFromPath("script.sh")).toBe("bash")
  expect(langFromPath("Cargo.toml")).toBe("toml")
  expect(langFromPath("main.rs")).toBe("rust")
})

test("maps special basenames", () => {
  expect(langFromPath("Dockerfile")).toBe("dockerfile")
  expect(langFromPath("Makefile")).toBe("make")
  expect(langFromPath("README.md")).toBe("markdown")
})

test("falls back to text", () => {
  expect(langFromPath("notes")).toBe("text")
  expect(langFromPath("weird.xyzzy")).toBe("text")
  expect(langFromPath("")).toBe("text")
})
