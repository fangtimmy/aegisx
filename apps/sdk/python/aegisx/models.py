"""Wire dataclasses for the AegisX management API.

Field names are snake_case (Pythonic); :func:`from_dict` maps the server's
camelCase keys onto them and ignores unknown fields (server may add fields the
SDK doesn't know — a MISSING known field fails loudly, which is drift
detection). Nested payloads the scheduler mostly displays (attachments, flags,
solved, targets, params, runStatusCounts) stay plain dicts; typed objects exist
where the scheduler reasons about the data.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, TypeVar

_WORD_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")
T = TypeVar("T")


def _now_ms() -> int:
    """Current epoch time in milliseconds (container clock shares the host
    kernel clock, so epoch deltas against server ISO strings are reliable)."""
    return int(time.time() * 1000)


def _parse_iso_ms(iso: str) -> int:
    """Parse a server ISO-8601 UTC timestamp (e.g. `2025-01-01T00:00:00.000Z`)
    to epoch milliseconds. Handles the `Z` suffix (Python < 3.11 rejects it)
    and treats naive strings as UTC."""
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def fmt_ms(ms: int) -> str:
    """Milliseconds → human duration, shared format with the server digest:
    `3500` → `"4s"`, `210000` → `"3m30s"`, `60000` → `"1m"`, `-45000` →
    `"-45s(超时)"`. Use integer ms properties for comparisons; this is for
    display only."""
    if ms < 0:
        return f"-{fmt_ms(-ms)}(超时)"
    total_sec = round(ms / 1000)
    if total_sec < 60:
        return f"{total_sec}s"
    m, s = divmod(total_sec, 60)
    if m >= 60:
        h, rem = divmod(m, 60)
        return f"{h}h" if rem == 0 else f"{h}h{rem}m"
    return f"{m}m" if s == 0 else f"{m}m{s}s"


def _snake(name: str) -> str:
    """camelCase → snake_case (e.g. `hasAcceptedFlag` → `has_accepted_flag`)."""
    return _WORD_BOUNDARY.sub("_", name).lower()


def from_dict(cls: type[T], payload: dict[str, Any] | None) -> T | None:
    """Build a dataclass from a wire dict (camelCase → snake_case)."""
    if payload is None:
        return None
    fields = cls.__dataclass_fields__
    return cls(
        **{_snake(k): v for k, v in payload.items() if _snake(k) in fields}
    )


@dataclass
class Challenge:
    """One challenge in the event. `solved` / `run_status_counts` / attachments
    / flags / targets are raw dicts — see the `solved_now` property for the
    aggregate solved check."""

    id: str
    event_id: str
    name: str
    description: str
    category: str | None
    points: int | None
    created_at: str
    updated_at: str
    solved: dict[str, str]
    run_count: int
    run_status_counts: dict[str, int]
    attachments: list[dict[str, Any]]
    flags: list[dict[str, Any]]
    remote_id: str | None
    remote_available: bool
    remote_target: bool
    remote_target_ignored: bool
    remote_target_count: int
    targets: list[dict[str, Any]]
    remote_updated_at: str | None

    @property
    def solved_now(self) -> bool:
        """Solved locally (accepted flag), manually, or on the remote."""
        return any(
            self.solved.get(k) == "solved"
            for k in ("local", "manual", "remote")
        )


@dataclass
class QueueItem:
    """One item in the event task queue. `params` holds the v9 launch specs
    (strategy/model/solverCount/solvers). `status`: pending | running | done |
    cancelled | failed."""

    id: str
    event_id: str
    ord: int
    challenge_id: str
    challenge_name: str
    params: dict[str, Any]
    timeout_ms: int | None
    prompt: str
    source: str
    status: str
    run_id: str | None
    error: str | None
    created_at: str
    updated_at: str


@dataclass
class Run:
    """A challenge solver run or the event scheduler run (scope_type)."""

    id: str
    scope_type: str
    event_id: str
    challenge_id: str | None
    challenge_name: str
    status: str
    finishing: bool
    source: str
    target_supported: bool
    provider: str
    model_id: str
    model_name: str
    thinking_level: str
    environment: str
    image: str
    cpus: int
    memory_mb: int
    pids_limit: int
    container_name: str
    created_at: str
    started_at: str | None
    updated_at: str
    completed_at: str | None
    deadline_at: str | None
    last_timeout_at: str | None
    error: str | None
    summary: str | None
    has_accepted_flag: bool
    # Present on detail responses only (absent → None).
    usage: dict[str, Any] | None = None

    @property
    def active(self) -> bool:
        return self.status in ("running", "idle")

    # --- time visibility (docs/scheduler-inbox.md §3.2) ---------------------
    # Computed on every access (fresh); always integer ms. Judge with these
    # values — do NOT parse the ISO strings yourself (timezone/naive traps).

    @property
    def elapsed_ms(self) -> int | None:
        """started_at → now; None until the run starts."""
        if not self.started_at:
            return None
        return _now_ms() - _parse_iso_ms(self.started_at)

    @property
    def deadline_remain_ms(self) -> int | None:
        """deadline_at − now; None when there is no deadline or the run is
        over (closed). Negative = already over the deadline."""
        if not self.deadline_at or self.status == "closed":
            return None
        return _parse_iso_ms(self.deadline_at) - _now_ms()

    @property
    def overdue(self) -> bool:
        """Deadline passed but the run is still active (running/idle)."""
        remain = self.deadline_remain_ms
        return remain is not None and remain < 0

    @property
    def last_activity_age_ms(self) -> int:
        """updated_at → now."""
        return _now_ms() - _parse_iso_ms(self.updated_at)


@dataclass
class AgentSummary:
    """One agent (solver-N or orchestrator) inside a run."""

    id: str
    run_id: str
    slot: str
    role: str
    parent_agent_id: str | None
    is_entry: bool
    name: str | None
    task: str | None
    model: str | None
    status: str
    session_file: str | None
    created_at: str
    started_at: str | None
    updated_at: str
    completed_at: str | None
    error: str | None

    @property
    def idle_age_ms(self) -> int:
        """updated_at → now (docs/scheduler-inbox.md §3.2)."""
        return _now_ms() - _parse_iso_ms(self.updated_at)


@dataclass
class RunRead:
    """Composed run detail: the run, its agents, and the target agent's recent
    message lines (rendered `[role] text` — see runs.read)."""

    run: Run
    agents: list[AgentSummary]
    agent: AgentSummary | None
    messages: list[str]
    last_assistant: str | None = None


@dataclass
class Channel:
    """One channel in the caller's visible face (docs/im-channels.md). `kind`:
    team | announce | dm. `label` is the display name ("#team" / "#announce" /
    "DM Solver 1" / the event scheduler DM). `unread` counts messages past the
    caller's read cursor (recaps + own posts excluded)."""

    id: str
    scope_type: str
    run_id: str | None
    event_id: str
    kind: str
    target_agent_id: str | None
    label: str
    unread: int
    last_message_at: str | None


@dataclass
class ChannelFile:
    """Attachment metadata (📎 filename · size — content is fetched
    separately via `aegisx.channels.fetch`)."""

    id: str
    filename: str
    size: int


@dataclass
class ChannelMessage:
    """One channel message. `kind`: text | recap (a stored digest snapshot).
    `author_type`: system | user | agent."""

    id: int
    channel_id: str
    kind: str
    author_type: str
    author_agent_id: str | None
    author_name: str
    body: str
    meta: dict[str, Any]
    created_at: str
    files: list[ChannelFile]


@dataclass
class SchedulerStatus:
    """Concurrency / target-slot usage snapshot for the event."""

    max_concurrent_runs: int
    running_count: int
    max_concurrent_targets: int
    active_target_challenges: list[str]
    active_runs: list[dict[str, Any]]


@dataclass
class Snapshot:
    """One-shot full picture (aegisx.snapshot): challenges + queue + runs +
    agents + scheduler status/config."""

    challenges: list[Challenge]
    queue: list[QueueItem]
    queue_state: str
    runs: list[Run]
    agents_by_run: dict[str, list[AgentSummary]]
    scheduler_run: Run | None
    scheduler_agents: list[AgentSummary]
    scheduler_config: dict[str, Any] | None
    status: SchedulerStatus
