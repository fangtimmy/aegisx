import { PlatformError } from "./platform"

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

export function platformError(error: unknown): PlatformActionError {
  if (error instanceof PlatformActionError) return error
  if (error instanceof PlatformError) {
    return new PlatformActionError("platform_error", error.message)
  }
  return new PlatformActionError("platform_error", "Platform request failed")
}
