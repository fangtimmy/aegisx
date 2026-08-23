"""The SDK's single failure type (leaf module — safe to import anywhere)."""
from __future__ import annotations


class AegisxError(Exception):
    """API error. `code` mirrors the server's error code so scripts can
    branch on it; `status` is the HTTP status; `message` is the server's
    message, or a client-side failure description.

    Common codes: forbidden (outside your role's API surface), unauthorized
    (bad token), not_found, invalid_state (e.g. compaction without a live
    session), capacity (back off and adjust the plan), network_error,
    bad_response."""

    def __init__(self, code: str, message: str, status: int | None = None):
        suffix = f" (HTTP {status})" if status is not None else ""
        super().__init__(f"[{code}] {message}{suffix}")
        self.code = code
        self.message = message
        self.status = status
