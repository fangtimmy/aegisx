import type { Context } from "hono"

import { jsonError } from "../infrastructure/http-errors"
import { PlatformError } from "./core"

export class PlatformActionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_bound"
      | "invalid_state"
      | "platform_error",
    message: string
  ) {
    super(message)
  }
}

/**
 * Normalize any thrown value into a {@link PlatformActionError}. Already-mapped
 * errors pass through unchanged; SDK-level {@link PlatformError}s and unknown
 * errors collapse to a generic `platform_error`.
 */
export function platformError(error: unknown): PlatformActionError {
  if (error instanceof PlatformActionError) return error
  if (error instanceof PlatformError) {
    return new PlatformActionError("platform_error", error.message)
  }
  return new PlatformActionError("platform_error", "Platform request failed")
}

/** Map a {@link PlatformActionError} code to its HTTP status. */
function platformActionStatus(
  code: PlatformActionError["code"]
): 400 | 404 | 409 | 502 {
  switch (code) {
    case "not_found":
      return 404
    case "invalid_state":
      return 409
    case "not_bound":
      return 400
    default:
      return 502
  }
}

/**
 * Convert a platform-layer exception into its JSON HTTP error response. The
 * single source of truth for the `PlatformActionError → status` mapping, used
 * by every route handler that delegates to the platform service.
 */
export function platformActionHttpError(c: Context, error: unknown) {
  const mapped = platformError(error)
  return jsonError(
    c,
    { code: mapped.code, message: mapped.message },
    platformActionStatus(mapped.code)
  )
}
