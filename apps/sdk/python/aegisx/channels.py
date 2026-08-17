"""`aegisx.channels` — the unified message layer (docs/im-channels.md).

Every run has a channel tree (#team / #announce / DM per solver) plus the
event-scope scheduler DM. The caller's identity comes from the per-exec env
`AEGISX_AGENT_ID` (injected by the bash tool), so the server resolves "my
channels" without any token.

Solver face:
    aegisx.channels.list()                          # my channels + unread
    aegisx.channels.read("#team")                   # pull = read (cursor moves)
    aegisx.channels.post("#team", text, files=["exp2.py"])
    aegisx.ask("target expires in 3min — extend or drop?", urgent=True)
    aegisx.channels.fetch(file_id)                  # materialize an attachment

Attachment semantics: `files` are workspace-relative paths, snapshot-copied at
post time (later workspace edits never mutate a sent attachment). `fetch`
writes into /workspace/inbox/<filename>; steer texts only ever show 📎
filename/size metadata — fetch to see content.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .client import AegisxError, get_client
from .models import Channel, ChannelFile, ChannelMessage, from_dict

#: Default materialization dir (relative to the workspace cwd).
FETCH_INBOX_DIR = "inbox"


def list() -> list[Channel]:
    """My visible channels + unread counts: #team / #announce / my DM (solvers,
    plus the event scheduler DM) — or every channel in the event (scheduler)."""
    caller = _caller()
    data = get_client().request("GET", f"/api/agents/{caller}/channels")
    return [from_dict(Channel, item) for item in data.get("items", [])]


def read(
    channel: str,
    after: int | None = None,
    limit: int = 50,
    mark_read: bool = True,
) -> list[ChannelMessage]:
    """Pull a channel's messages (ascending id). Pull = read: the caller's
    cursor advances, so already-read messages are never re-steered.
    `channel` is "#team" / "#announce" / a channel id from list()."""
    caller = _caller()
    query: dict[str, Any] = {"limit": limit}
    if after is not None and after > 0:
        query["after"] = after
    if not mark_read:
        query["markRead"] = "0"
    data = get_client().request(
        "GET", f"/api/channels/{_sel(channel)}/messages", query=query
    )
    return [from_dict(ChannelMessage, item) for item in data.get("items", [])]


def post(
    channel: str,
    text: str,
    tags: list[str] | None = None,
    files: list[str] | None = None,
) -> ChannelMessage:
    """Post a message. `files` are workspace-relative paths — the server
    resolve-checks them against YOUR run workspace and snapshot-copies the
    bytes into the channel file store. Caps: 64MB/file, 8 files, 128MB total,
    16K characters of text."""
    body: dict = {"text": text}
    if tags:
        body["tags"] = tags
    if files:
        body["files"] = files
    data = get_client().request(
        "POST", f"/api/channels/{_sel(channel)}/messages", body=body
    )
    return from_dict(ChannelMessage, data)


def ask(
    text: str, urgent: bool = False, files: list[str] | None = None
) -> ChannelMessage:
    """Ask the event scheduler (posts into the scheduler DM). urgent=True
    flushes the digest immediately; otherwise it rides the next digest."""
    scheduler = _scheduler_dm()
    if scheduler is None:
        raise AegisxError(
            "no_scheduler", "No scheduler DM channel for this event"
        )
    body: dict = {"text": text}
    if urgent:
        body["urgent"] = True
    if files:
        body["files"] = files
    data = get_client().request(
        "POST", f"/api/channels/{scheduler.id}/messages", body=body
    )
    return from_dict(ChannelMessage, data)


def fetch(file_id: str, dest: str | None = None) -> str:
    """Materialize an attachment into YOUR workspace (default
    <workspace>/inbox/<original filename>) and return the written path. The
    channel file store is never container-mounted — bytes move through this
    HTTP copy, keeping the container boundary intact."""
    meta = get_client().request(
        "GET", f"/api/channel-files/{file_id}", query={"meta": "1"}
    )
    filename = "attachment"
    if isinstance(meta, dict):
        filename = meta.get("filename") or filename
    target = dest or str(Path(FETCH_INBOX_DIR) / Path(filename).name)
    if os.path.isabs(target):
        raise AegisxError(
            "invalid", "dest must be workspace-relative, not absolute"
        )
    return get_client().download(f"/api/channel-files/{file_id}", target)


def announce(run_id: str, text: str) -> ChannelMessage:
    """Scheduler-only: broadcast to a run's #announce (steers every live
    solver). Use for FYI guidance; use `aegisx.agents.message` for directives
    targeting one solver."""
    from .client import require_manager

    require_manager()
    channel = _run_channel(run_id, "announce")
    data = get_client().request(
        "POST", f"/api/channels/{channel.id}/messages", body={"text": text}
    )
    return from_dict(ChannelMessage, data)


# --- internals ---------------------------------------------------------------


def _caller() -> str:
    caller = os.environ.get("AEGISX_AGENT_ID", "")
    if not caller:
        raise AegisxError(
            "no_agent",
            "AEGISX_AGENT_ID is not set — channels calls need the per-exec "
            "identity env (run inside the agent's bash tool)",
        )
    return caller


def _sel(channel: str) -> str:
    """Map friendly selectors onto URL-safe path segments ("#team" → "team")."""
    return channel[1:] if channel.startswith("#") else channel


def _scheduler_dm() -> Channel | None:
    for channel in list():
        if channel.scope_type == "event" and channel.kind == "dm":
            return channel
    return None


def _run_channel(run_id: str, kind: str) -> Channel:
    for channel in list():
        if channel.run_id == run_id and channel.kind == kind:
            return channel
    raise AegisxError("not_found", f"No {kind} channel for run {run_id}")
