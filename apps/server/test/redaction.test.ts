import { expect, test } from "bun:test"
import { redactSecrets } from "../src/redaction"

test("redacts secrets from strings and nested values", () => {
  expect(redactSecrets("token=secret", ["secret"])).toBe("token=[redacted]")
  expect(
    redactSecrets({ error: { message: "secret" }, values: ["secret"] }, [
      "secret",
    ])
  ).toEqual({
    error: { message: "[redacted]" },
    values: ["[redacted]"],
  })
})
