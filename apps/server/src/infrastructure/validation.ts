import { tbValidator } from "@hono/typebox-validator"

export const validateJson = <T extends Parameters<typeof tbValidator>[1]>(
  schema: T
) =>
  tbValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: { code: "invalid_request", message: "Invalid request body" } },
        400
      )
    }
    return undefined
  })
