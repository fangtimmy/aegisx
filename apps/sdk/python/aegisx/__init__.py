"""AegisX scheduler SDK — programmatic management API for the event-scope
orchestrator.

The scheduler runs inside a container with this package on PYTHONPATH and
`AEGISX_EVENT_ID` (+ `AEGISX_API_URL` when the host is not reachable via the
default) injected. Zero third-party dependencies — pure stdlib urllib.

Typical script (run via bash heredoc — one script per decision, not one call
per line):

    import aegisx

    snap = aegisx.snapshot()          # full picture: challenges+queue+runs+agents
    for c in snap.challenges:         # weighted pick
        if not c.solved_now and c.points:
            print(c.id, c.points, c.name, c.run_status_counts)
    # ...decide, then act in the same script:
    item = aegisx.queue.enqueue("ch-xxx", strategy="pwn, check remote first")
    print(item.status, item.id)

Error handling: every failure raises `aegisx.AegisxError` with `.code`
mirroring the server's error code (e.g. "capacity" → back off and adjust the
plan; "not_found" → re-read state). Never parse error text.

Rules:
- Keep printed output small (bash truncates at ~64KB): print summaries, write
  bulk to files.
- Do one composite operation per script; persist reusable helpers in
  /workspace/scheduler_lib.py and `import scheduler_lib`.
"""
from __future__ import annotations

from . import agents, challenges, channels, queue, runs
from .client import AegisxError, configure, get_client
from .models import (
    AgentSummary,
    Challenge,
    Channel,
    ChannelFile,
    ChannelMessage,
    QueueItem,
    Run,
    RunRead,
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
    "Run",
    "RunRead",
    "SchedulerStatus",
    "Snapshot",
    "agents",
    "ask",
    "challenges",
    "channels",
    "configure",
    "fmt_ms",
    "queue",
    "runs",
    "snapshot",
    "status",
]


def ask(text: str, urgent: bool = False, files: list[str] | None = None):
    """Ask the event scheduler (solver face; docs/im-simplify-v18.md): posts
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
    """One-shot full picture: challenges + queue + runs + agents + scheduler
    status/config. Call this before deciding, to minimize round trips."""
    client = get_client()
    fleet = client.request("GET", client.event_path("/fleet"))
    queue_data = client.request("GET", client.event_path("/queue"))
    event_data = client.request("GET", client.event_path(""))
    return Snapshot(
        challenges=_items(Challenge, event_data.get("challenges", [])),
        queue=_items(QueueItem, queue_data.get("items", [])),
        queue_state=queue_data.get("state", ""),
        runs=_items(Run, fleet.get("runs", [])),
        agents_by_run={
            run_id: _items(AgentSummary, agent_list)
            for run_id, agent_list in fleet.get("agentsByRun", {}).items()
        },
        scheduler_run=(
            _one(Run, fleet["schedulerRun"])
            if fleet.get("schedulerRun")
            else None
        ),
        scheduler_agents=_items(
            AgentSummary, fleet.get("schedulerAgents", [])
        ),
        scheduler_config=fleet.get("config"),
        status=_one(SchedulerStatus, fleet.get("status", {})),
    )


def status() -> SchedulerStatus:
    """Concurrency / target-slot usage snapshot. Call before planning the next
    action so you respect the hard caps."""
    client = get_client()
    data = client.request("GET", client.event_path("/scheduler"))
    return _one(SchedulerStatus, data.get("status", {}))
