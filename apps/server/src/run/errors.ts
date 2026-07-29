export class RunActionError extends Error {
  constructor(
    readonly code: "capacity" | "not_found" | "invalid_state" | "launch_failed",
    message: string
  ) {
    super(message)
  }
}

export class RunStartError extends Error {}
