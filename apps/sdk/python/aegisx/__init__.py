"""AegisX agent SDK — programmatic access for the event scheduler (and the
channels face for solvers).

The scheduler runs inside a container with this package on PYTHONPATH and
`AEGISX_EVENT_ID` + `AEGISX_API_URL` injected; per-exec env carries
`AEGISX_AGENT_ID` + `AEGISX_TOKEN` (the server derives your identity and
role from the token — everything outside your role's surface is rejected
with `.code == "forbidden"`). Zero third-party dependencies — pure stdlib.

Typical script (run via bash heredoc — one script per decision, not one call
per line):

    import aegisx

    snap = aegisx.snapshot()          # challenges + agents + queue + status
    for c in snap.challenges:         # weighted pick
        if not c.solved_now and c.points:
            print(c.id, c.points, c.name, c.agent_status_counts)
    # ...decide, then act in the same script — one typed plan:
    res = aegisx.submit_plan("web-01 done; budget moves to web-02", [
        aegisx.close("agent-a3f1"),
        aegisx.enqueue("ch-web02", prompt="pwn, check remote first"),
    ])
    print([(r.ref, r.ok) for r in res.results])

Error handling: every failure raises `aegisx.AegisxError` with `.code`
mirroring the server's error code (e.g. "not_found" → re-read state;
"forbidden" → outside your surface). Never parse error text. Plan
validation errors are the exception: they are per-ref results on
`submit_plan`'s return value, not raised exceptions.

Rules:
- Keep printed output small (bash truncates at ~64KB): print summaries, write
  bulk to files.
- Do one composite operation per script; persist reusable helpers in
  scheduler_lib.py in your working directory and `import scheduler_lib`.
- Every delivery to you ends with a [调度快照] block (delivery-time fleet
  snapshot: caps, queue, per-challenge agents) — decide from it when it
  suffices; call `snapshot()` only when you need finer detail.
- Full usage guide: /opt/aegisx-sdk/GUIDE.md.
"""
from __future__ import annotations

from . import agents, challenges, channels, plan, queue
from .client import configure, get_client
from .errors import AegisxError
from .models import (
    AgentSummary,
    Challenge,
    Channel,
    ChannelFile,
    ChannelMessage,
    DeferredAction,
    MessageList,
    PlanRefResult,
    QueueItem,
    AgentRead,
    SchedulerStatus,
    Snapshot,
    SubmitPlanResult,
    fmt_ms,
    from_dict,
)
from .plan import (
    cancel_item,
    close,
    enqueue,
    finish,
    message,
    no_op,
    reorder,
    set_deadline,
    set_queue_paused,
    stop,
    submit_plan,
)
from typing import TypeVar

T = TypeVar("T")

__all__ = [
    "AegisxError",
    "AgentRead",
    "AgentSummary",
    "Challenge",
    "Channel",
    "ChannelFile",
    "ChannelMessage",
    "DeferredAction",
    "MessageList",
    "PlanRefResult",
    "QueueItem",
    "SchedulerStatus",
    "Snapshot",
    "SubmitPlanResult",
    "agents",
    "ask",
    "cancel_item",
    "challenges",
    "channels",
    "close",
    "configure",
    "enqueue",
    "finish",
    "fmt_ms",
    "message",
    "no_op",
    "plan",
    "queue",
    "reorder",
    "set_deadline",
    "set_queue_paused",
    "snapshot",
    "status",
    "stop",
    "submit_plan",
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
    # Challenges come from the event endpoint (full publicChallenge records —
    # the fleet view's challenge list is the web overview's 3-field digest
    # and too thin to build Challenge from).
    event_data = client.request("GET", client.event_path(""))
    fleet = client.request("GET", client.event_path("/fleet"))
    queue_data = client.request("GET", client.event_path("/queue"))
    return Snapshot(
        challenges=_items(Challenge, event_data.get("challenges", [])),
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
