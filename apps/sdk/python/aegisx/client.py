"""Minimal urllib client for the AegisX HTTP API (zero third-party deps).

The module-wide default client reads `AEGISX_API_URL` (default
`http://host.docker.internal:3000`) and `AEGISX_EVENT_ID` from the
environment at import; override per-process with :func:`aegisx.configure`.

Identity: the per-exec env `AEGISX_TOKEN` (injected next to
`AEGISX_AGENT_ID` by the bash tool) rides every request as a Bearer header —
the server derives who and what role you are from it. There is no
client-side role gating: the server's 403 `forbidden` (an `AegisxError` with
`.code == "forbidden"`) is the single boundary.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_API_URL = os.environ.get(
    "AEGISX_API_URL", "http://host.docker.internal:3000"
)


def agent_id() -> str:
    """The calling agent's id (per-exec env AEGISX_AGENT_ID) or an empty
    string. Used to address your own agent face (channels.list); the server
    verifies it against the token."""
    return os.environ.get("AEGISX_AGENT_ID", "")


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


class Client:
    """Thin JSON client. `request` returns the parsed JSON body, or None on
    an empty (204) response. HTTP errors raise :class:`AegisxError` with the
    server's `{code, message}` payload preserved."""

    def __init__(self, api_url: str | None = None, event_id: str | None = None):
        self.api_url = (api_url or DEFAULT_API_URL).rstrip("/")
        self.event_id = event_id or os.environ.get("AEGISX_EVENT_ID", "")

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        url = self.api_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        token = os.environ.get("AEGISX_TOKEN", "")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise _http_error(error) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise AegisxError(
                "network_error", f"Request to {url} failed: {error}"
            ) from None
        except json.JSONDecodeError as error:
            raise AegisxError(
                "bad_response", f"Invalid JSON from {url}: {error}"
            ) from None

    def event_path(self, suffix: str = "") -> str:
        """`/api/events/<event_id><suffix>` — event-scoped API base."""
        if not self.event_id:
            raise AegisxError(
                "no_event",
                "AEGISX_EVENT_ID is not set — call aegisx.configure(event_id=...) "
                "or pass an event_id",
            )
        return f"/api/events/{self.event_id}{suffix}"


def _http_error(error: urllib.error.HTTPError) -> AegisxError:
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except Exception:
        return AegisxError("http_error", f"HTTP {error.code}", error.code)
    if isinstance(payload, dict):
        # Error envelope is `{error: {code, message}}` (and some legacy paths
        # return the fields top-level) — accept both.
        body = (
            payload["error"]
            if isinstance(payload.get("error"), dict)
            else payload
        )
        return AegisxError(
            body.get("code") or "http_error",
            body.get("message") or f"HTTP {error.code}",
            error.code,
        )
    return AegisxError("http_error", str(payload), error.code)


_default_client = Client()


def get_client() -> Client:
    return _default_client


def configure(api_url: str | None = None, event_id: str | None = None) -> None:
    """Override the module-wide API url / event id for this process. Both
    optional; omitted values fall back to the env-based defaults."""
    global _default_client
    _default_client = Client(api_url=api_url, event_id=event_id)
