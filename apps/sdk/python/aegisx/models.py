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
_LIST_OF_DATACLASS = re.compile(r"list\[(\w+)\]")
T = TypeVar("T")


def _now_ms() -> int:
    """Current epoch time in milliseconds (container clock shares the host
    kernel clock, so epoch deltas against server ISO strings are reliable)."""
    return round(time.time() * 1000)


def _parse_iso_ms(iso: str) -> int:
    """Parse a server ISO-8601 UTC timestamp (e.g. `2025-01-01T00:00:00.000Z`)
    to epoch milliseconds. Handles the `Z` suffix (Python < 3.11 rejects it)
    and treats naive strings as UTC."""
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return round(dt.timestamp() * 1000)


def fmt_ms(ms: int) -> str:
    """Milliseconds → human duration, shared format with the server's
    watchdog/delivery lines: `3500` → `"4s"`, `210000` → `"3m30s"`,
    `60000` → `"1m"`, `-45000` → `"-45s(超时)"`. Use integer ms properties for
    comparisons; this is for display only."""
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


#: Dataclasses that appear NESTED inside wire payloads — from_dict builds
#: these recursively via their `list[<name>]` field annotations.
_NESTED_TYPES: dict[str, type] = {}


def _convert_field(annotation: Any, value: Any) -> Any:
    """Build nested dataclasses for `list[<Dataclass>]` annotations; every
    other value passes through untouched (plain dicts stay dicts by design)."""
    match = _LIST_OF_DATACLASS.fullmatch(str(annotation))
    if match and isinstance(value, list):
        inner = _NESTED_TYPES.get(match.group(1))
        if inner is not None:
            out = []
            for item in value:
                built = from_dict(inner, item)
                if built is not None:
                    out.append(built)
            return out
    return value


def from_dict(cls: type[T], payload: dict[str, Any] | None) -> T | None:
    """Build a dataclass from a wire dict (camelCase → snake_case). Nested
    `list[<Dataclass>]` fields are built recursively; unknown keys are
    ignored (server may add fields the SDK doesn't know — a MISSING known
    field fails loudly, which is drift detection)."""
    if payload is None:
        return None
    fields = getattr(cls, "__dataclass_fields__", {})
    kwargs: dict[str, Any] = {}
    for key, value in payload.items():
        name = _snake(key)
        field = fields.get(name)
        if field is None:
            continue
        kwargs[name] = _convert_field(field.type, value)
    return cls(**kwargs)


@dataclass
class Challenge:
    """One challenge in the event. `solved` / `agent_status_counts` /
    attachments / flags / targets are raw dicts — see the `solved_now`
    property for the aggregate solved check."""

    id: str
    event_id: str
    name: str
    description: str
    category: str | None
    points: int | None
    created_at: str
    updated_at: str
    solved: dict[str, str]
    agent_count: int
    agent_status_counts: dict[str, int]
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
    """One item in the event spawn queue. `params` holds the v19 spawn specs
    (prompt/model/promptMode). `status`: pending | running | done | cancelled
    | failed. `agent_id` is back-filled when the drainer spawns the agent."""

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
    agent_id: str | None
    error: str | None
    created_at: str
    updated_at: str


@dataclass
class AgentSummary:
    """v19 agent: the execution unit. One attempt on a challenge = one agent
    (challenge_id null = the event's scheduler agent). Snapshotted at spawn:
    model, prompt, tools, deadline. Terminal: summary/error."""

    id: str
    event_id: str
    challenge_id: str | None
    challenge_name: str
    role: str
    name: str | None
    model: str | None
    status: str
    source: str
    prompt: str | None
    summary: str | None
    error: str | None
    deadline_at: str | None
    last_timeout_at: str | None
    created_at: str
    started_at: str | None
    updated_at: str
    completed_at: str | None

    @property
    def active(self) -> bool:
        return self.status in ("running", "idle")

    @property
    def elapsed_ms(self) -> int | None:
        """started_at → now; None until the agent starts."""
        if not self.started_at:
            return None
        return _now_ms() - _parse_iso_ms(self.started_at)

    @property
    def deadline_remain_ms(self) -> int | None:
        """deadline_at − now; None when there is no deadline or the agent is
        terminal. Negative = already over the deadline."""
        if not self.deadline_at or not self.active:
            return None
        return _parse_iso_ms(self.deadline_at) - _now_ms()

    @property
    def overdue(self) -> bool:
        """Deadline passed but the agent is still active (running/idle)."""
        remain = self.deadline_remain_ms
        return remain is not None and remain < 0

    @property
    def last_activity_age_ms(self) -> int:
        """updated_at → now."""
        return _now_ms() - _parse_iso_ms(self.updated_at)

    @property
    def idle_age_ms(self) -> int:
        """updated_at → now (docs/scheduler-inbox.md §3.2)."""
        return _now_ms() - _parse_iso_ms(self.updated_at)


@dataclass
class AgentRead:
    """Composed agent detail: the agent summary + its recent message lines
    (rendered `[role] text` — see agents.read). `messages` is filled by
    `agents.read`; absent on a bare `agents.get`."""

    agent: AgentSummary
    tools: list[str]
    tool_definitions: list[dict[str, Any]]
    system_prompt: str
    session_file: str | None
    usage: dict[str, Any] | None
    workspace: dict[str, Any] | None
    messages: list[str] | None = None


@dataclass
class Channel:
    """One channel in the caller's visible face (v19). Channels are DERIVED
    KEYS stored on messages: `key` is "team:<challengeId>" (#team, shared by
    every agent on the challenge) | "dm:<agentId>" (scheduler/user/system →
    one agent) | "orch:<eventId>" (solver asks + system events → the
    scheduler). `kind`: team | dm | orch. `unread` counts messages past the
    caller's read cursor (own posts excluded). `live_agent_count` (team
    channel only) = live agents sharing the channel."""

    key: str
    kind: str
    label: str
    event_id: str
    challenge_id: str | None
    agent_id: str | None
    unread: int
    last_message_at: str | None
    live_agent_count: int | None = None


@dataclass
class ChannelFile:
    """Attachment metadata: a shared/ path the reader opens directly (no
    fetch). `path` is relative to the workspace root (e.g.
    `shared/from-a3f1c2d9/exp2.py`); solvers read /workspace/<path>, the
    scheduler reads /challenges/<cid>/workspace/<path>."""

    path: str
    filename: str
    size: int


# ChannelMessage.files is the one nested wire list — register AFTER the class
# exists (from_dict looks _NESTED_TYPES up at call time).
_NESTED_TYPES["ChannelFile"] = ChannelFile


@dataclass
class ChannelMessage:
    """One channel message. `author_type`: system | user | agent. `meta`
    carries `urgent` (immediate delivery), `agentId` (signed attribution),
    `eventType`, `tags`."""

    id: int
    channel_key: str
    author_type: str
    author_agent_id: str | None
    author_name: str
    body: str
    meta: dict[str, Any]
    created_at: str
    files: list[ChannelFile]


@dataclass
class SchedulerStatus:
    """Concurrency / target-slot usage snapshot for the event (v19). The
    scheduler agent never counts toward the live-agent cap."""

    max_concurrent_agents: int
    live_agent_count: int
    max_concurrent_targets: int
    active_target_challenges: list[str]
    active_agents: list[dict[str, Any]]


@dataclass
class Snapshot:
    """One-shot full picture (aegisx.snapshot): challenges + per-challenge
    agents + the scheduler agent + scheduler status/config."""

    challenges: list[Challenge]
    agents_by_challenge: dict[str, list[AgentSummary]]
    scheduler_agent: AgentSummary | None
    queue: list[QueueItem]
    queue_state: str
    scheduler_config: dict[str, Any] | None
    status: SchedulerStatus
