"""AegisX scheduler SDK — programmatic management API for the event-scope
orchestrator.

The scheduler runs inside a container with this package on PYTHONPATH and
`AEGISX_EVENT_ID` (+ `AEGISX_API_URL` when the host is not reachable via the
default) injected. Zero third-party dependencies — pure stdlib urllib.

Typical script (run via bash heredoc — one script per decision, not one call
per line):

    import aegisx

    snap = aegisx.snapshot()          # challenges + agents + queue + status
    for c in snap.challenges:         # weighted pick
        if not c.solved_now and c.points:
            print(c.id, c.points, c.name, c.agent_status_counts)
    # ...decide, then act in the same script:
    item = aegisx.queue.enqueue("ch-xxx", prompt="pwn, check remote first")
    print(item.status, item.id)

Error handling: every failure raises `aegisx.AegisxError` with `.code`
mirroring the server's error code (e.g. "capacity" → back off and adjust the
plan; "not_found" → re-read state). Never parse error text.

Rules:
- Keep printed output small (bash truncates at ~64KB): print summaries, write
  bulk to files.
- Do one composite operation per script; persist reusable helpers in
  scheduler_lib.py in your working directory and `import scheduler_lib`.
- Every delivery to you ends with a [调度快照] block (delivery-time fleet
  snapshot: caps, queue, per-challenge agents) — decide from it when it
  suffices; call `snapshot()` only when you need finer detail.
"""
from __future__ import annotations

from . import agents, challenges, channels, queue
from .client import AegisxError, configure, get_client
from .models import (
    AgentSummary,
    Challenge,
    Channel,
    ChannelFile,
    ChannelMessage,
    QueueItem,
    AgentRead,
    SchedulerStatus,
    Snapshot,
    fmt_ms,
    from_dict,
)
from typing import TypeVar

T = TypeVar("T")

__all__ = [
    "AegisxError",
    "AgentSummary",
    "Challenge",
    "Channel",
    "ChannelFile",
    "ChannelMessage",
    "QueueItem",
    "AgentRead",
    "SchedulerStatus",
    "Snapshot",
    "agents",
    "ask",
    "challenges",
    "channels",
    "configure",
    "fmt_ms",
    "queue",
    "snapshot",
    "status",
]


def ask(text: str, urgent: bool = False, files: list[str] | None = None):
    """Ask the event scheduler (solver face): posts
    into orch:<eventId>. urgent=True wakes the scheduler immediately (e.g.
    "target expires in 3min — extend or drop?"); otherwise the question
    rides the next delivery tick. Returns the posted ChannelMessage."""
    return channels.ask(text, urgent=urgent, files=files)


def _items(cls: type[T], raw):
    """Build a compact list from raw wire items (from_dict Nones dropped —
    a malformed item is skipped, not fatal)."""
    out = []
    for item in raw or []:
        built = from_dict(cls, item)
        if built is not None:
            out.append(built)
    return out


def _one(cls: type[T], raw):
    """from_dict narrowed to non-None (the server always sends the object)."""
    built = from_dict(cls, raw)
    if built is None:
        raise AegisxError("bad_response", f"malformed {cls.__name__} payload")
    return built


def snapshot() -> Snapshot:
    """One-shot full picture: challenges + per-challenge agents + the scheduler
    agent + scheduler status/config. Call this before deciding, to minimize
    round trips."""
    client = get_client()
    fleet = client.request("GET", client.event_path("/fleet"))
    queue_data = client.request("GET", client.event_path("/queue"))
    return Snapshot(
        challenges=_items(Challenge, fleet.get("challenges", [])),
        agents_by_challenge={
            challenge_id: _items(AgentSummary, agent_list)
            for challenge_id, agent_list in fleet.get(
                "agentsByChallenge", {}
            ).items()
        },
        scheduler_agent=(
            _one(AgentSummary, fleet["schedulerAgent"])
            if fleet.get("schedulerAgent")
            else None
        ),
        queue=_items(QueueItem, queue_data.get("items", [])),
        queue_state=queue_data.get("state", ""),
        scheduler_config=fleet.get("config"),
        status=_one(SchedulerStatus, fleet.get("status", {})),
    )


def status() -> SchedulerStatus:
    """Concurrency / target-slot usage snapshot. Call before planning the next
    action so you respect the hard caps."""
    client = get_client()
    data = client.request("GET", client.event_path("/scheduler"))
    return _one(SchedulerStatus, data.get("status", {}))
