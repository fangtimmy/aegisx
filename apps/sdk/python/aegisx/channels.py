"""`aegisx.channels` — the derived-key message layer (docs/im-simplify-v18.md).

Channels are DERIVED KEYS, not directory rows: `team:<challengeId>` (#team,
shared by every run on the challenge), `dm:<agentId>` (scheduler/user/system
→ one solver), `orch:<eventId>` (solver asks + system events → the
scheduler). The first message makes a channel exist.

The caller's identity comes from the per-exec env `AEGISX_AGENT_ID`
(injected by the bash tool), so the server resolves "my channels" without
any token.

Solver face:
    aegisx.channels.list()                          # my channels + unread
    aegisx.channels.read("#team")                   # pull = read (cursor moves)
    aegisx.channels.post("#team", text, files=["exp2.py"], urgent=False)
    aegisx.ask("target expires in 3min — extend or drop?", urgent=True)
    aegisx.channels.fetch(file_id)                  # materialize an attachment

Delivery: urgent=True posts deliver immediately (wake the readers); False
posts merge into one delivery every ~5 minutes.

Attachment semantics: `files` are workspace-relative paths, snapshot-copied
at post time (later workspace edits never mutate a sent attachment). `fetch`
writes into /workspace/inbox/<filename>; steer texts only ever show 📎
filename/size metadata — fetch to see content.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .client import AegisxError, get_client
from .models import Channel, ChannelMessage, from_dict

#: Default materialization dir (relative to the workspace cwd).
FETCH_INBOX_DIR = "inbox"

#: Type aliases hoisted above `def list` — the module-level name `list`
#: shadows the builtin for every later annotation, so annotations must not
#: subscript `list` directly.
ChannelList = list[Channel]
MessageList = list[ChannelMessage]
StrList = list[str]


def _msg(data: Any) -> ChannelMessage:
    """Narrow from_dict's Optional to a message (server always returns one)."""
    message = from_dict(ChannelMessage, data)
    if message is None:
        raise AegisxError("bad_response", "malformed message payload")
    return message


def list() -> ChannelList:
    """My visible channels + unread counts (§2.2): solver = own #team + own
    dm + orch; scheduler = every #team of the event's challenges + every
    solver dm + orch."""
    caller = _caller()
    data = get_client().request("GET", f"/api/agents/{caller}/channels")
    channels: ChannelList = []
    for item in data.get("items", []):
        channel = from_dict(Channel, item)
        if channel is not None:
            channels.append(channel)
    return channels


def read(
    channel: str,
    after: int | None = None,
    limit: int = 50,
    mark_read: bool = True,
) -> MessageList:
    """Pull a channel's messages (ascending id). Pull = read: the caller's
    cursor advances, so already-read messages are never re-delivered.
    `channel` is "#team" / "orch" / a raw channel key from list()."""
    caller = _caller()
    query: dict[str, Any] = {"limit": limit}
    if after is not None and after > 0:
        query["after"] = after
    if not mark_read:
        query["markRead"] = "0"
    data = get_client().request(
        "GET", f"/api/channels/{_sel(channel)}/messages", query=query
    )
    items = []
    for item in data.get("items", []):
        message = from_dict(ChannelMessage, item)
        if message is not None:
            items.append(message)
    return items


def post(
    channel: str,
    text: str,
    tags: StrList | None = None,
    files: StrList | None = None,
    urgent: bool = False,
) -> ChannelMessage:
    """Post a message. `files` are workspace-relative paths — the server
    resolve-checks them against YOUR run workspace and snapshot-copies the
    bytes into the channel file store. Caps: 64MB/file, 8 files, 128MB total,
    16K characters of text. `urgent=True` delivers immediately (default
    False — findings merge into the ~5-minute delivery tick); mark urgent
    only time-sensitive findings (an expiring target, a race window)."""
    body: dict = {"text": text, "urgent": bool(urgent)}
    if tags:
        body["tags"] = tags
    if files:
        body["files"] = files
    data = get_client().request(
        "POST", f"/api/channels/{_sel(channel)}/messages", body=body
    )
    return _msg(data)


def ask(
    text: str, urgent: bool = False, files: StrList | None = None
) -> ChannelMessage:
    """Ask the event scheduler (posts into orch:<eventId>). urgent=True
    wakes the scheduler immediately (e.g. "target expires in 3min — extend
    or drop?"); otherwise the question rides the next delivery tick."""
    body: dict = {"text": text, "urgent": bool(urgent)}
    if files:
        body["files"] = files
    data = get_client().request(
        "POST", f"/api/channels/{_sel(orch())}/messages", body=body
    )
    return _msg(data)


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
    """Scheduler-only: broadcast to the challenge's #team (v18: one shared
    team channel per challenge — every live run's solvers receive it on the
    next delivery tick; non-urgent FYI by design). Use for FYI guidance; use
    `aegisx.agents.message` for directives targeting one solver."""
    from .client import require_manager

    require_manager()
    team = _run_team(run_id)
    data = get_client().request(
        "POST",
        f"/api/channels/{_sel(team)}/messages",
        body={"text": text, "urgent": False},
    )
    return _msg(data)


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
    """Map friendly selectors onto URL path segments ("#team" → "team";
    raw derived keys pass through — ':' is a legal path character)."""
    return channel[1:] if channel.startswith("#") else channel


def orch() -> str:
    """The caller's orch channel key (from the container env)."""
    client = get_client()
    if not client.event_id:
        raise AegisxError(
            "no_event",
            "AEGISX_EVENT_ID is not set — call aegisx.configure(event_id=...)",
        )
    return f"orch:{client.event_id}"


def _run_team(run_id: str) -> str:
    """Resolve a run's #team key via the run's channel tree (the LLM never
    assembles keys itself)."""
    data = get_client().request("GET", f"/api/runs/{run_id}/channels")
    for item in data.get("items", []):
        if item.get("kind") == "team":
            return str(item.get("key", ""))
    raise AegisxError("not_found", f"No #team channel for run {run_id}")
