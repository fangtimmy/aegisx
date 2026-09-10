import type { Context } from "hono"

import { jsonError } from "../infrastructure/http-errors"

export class RunActionError extends Error {
  constructor(
    readonly code:
      | "capacity"
      | "not_found"
      | "invalid_state"
      | "launch_failed"
      | "invalid"
      | "forbidden",
    message: string
  ) {
    super(message)
  }
}

export class RunStartError extends Error {}

/** Map a {@link RunActionError} to its HTTP response (404 / 500 / 429 / 400 /
 * 403 / 409 by code). Shared by the run and scheduler route modules. */
export function runActionError(c: Context, error: unknown) {
  if (!(error instanceof RunActionError)) throw error
  return jsonError(
    c,
    { code: error.code, message: error.message },
    error.code === "not_found"
      ? 404
      : error.code === "launch_failed"
        ? 500
        : error.code === "capacity"
          ? 429
          : error.code === "invalid"
            ? 400
            : error.code === "forbidden"
              ? 403
              : 409
  )
}
