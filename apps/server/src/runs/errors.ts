export class RunActionError extends Error {
  constructor(
    readonly code:
      | "capacity"
      | "not_found"
      | "invalid_state"
      | "message_id_conflict",
    message: string
  ) {
    super(message)
  }
}
