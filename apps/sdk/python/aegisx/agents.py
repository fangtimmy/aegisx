"""`aegisx.agents` — the agent-level read face.

Reads only: list the fleet, inspect one agent, replay its recent message
lines. Lifecycle and steering are the plan's business (`aegisx.submit_plan`
with message / stop / close / finish / set_deadline actions); hitting the
management endpoints from a solver token gets `forbidden` from the server.
"""
from __future__ import annotations

from .client import get_client
from .errors import AegisxError
from .models import AgentSummary, AgentRead, from_dict

#: Hoisted above `def list` — the module-level name shadows the builtin for
#: every later annotation.
AgentSummaries = list[AgentSummary]


def _summary(data) -> AgentSummary:
    summary = from_dict(AgentSummary, data)
    if summary is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return summary


def list(
    challenge_id: str | None = None,
    status: str | None = None,
) -> AgentSummaries:
    """The event's SOLVER agents, optionally scoped to one challenge /
    status. Use to pick an agent id for `aegisx.agents.read` or a plan
    action's target. The scheduler agent itself is NOT included — it is
    `aegisx.snapshot().scheduler_agent`."""
    client = get_client()
    path = client.event_path("/fleet")
    data = client.request("GET", path)
    agents: AgentSummaries = []
    for challenge in data.get("challenges", []):
        if challenge_id and challenge["id"] != challenge_id:
            continue
        for item in data.get("agentsByChallenge", {}).get(challenge["id"], []):
            summary = from_dict(AgentSummary, item)
            if summary is not None:
                if status and summary.status != status:
                    continue
                agents.append(summary)
    return agents


def get(agent_id: str) -> AgentRead:
    """Full agent detail (model snapshot, tools, usage, workspace info) — the
    pre-action assessment view."""
    data = get_client().request("GET", f"/api/agents/{agent_id}")
    read = from_dict(AgentRead, data)
    if read is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return read


def read(agent_id: str, limit: int | None = None) -> AgentRead:
    """The agent detail + its recent message lines (rendered `[role] text`).
    Pass `limit` to cap the tail (applied client-side — keep it small to
    respect the output budget)."""
    client = get_client()
    detail = client.request("GET", f"/api/agents/{agent_id}")
    msgs = client.request("GET", f"/api/agents/{agent_id}/messages")
    read = from_dict(AgentRead, detail)
    if read is None:
        raise AegisxError("bad_response", "malformed agent payload")
    lines: list[str] = []
    for item in msgs.get("items", []):
        entry = item.get("entry", {})
        message = entry.get("message", {}) if isinstance(entry, dict) else {}
        role = message.get("role", "") if isinstance(message, dict) else ""
        content = message.get("content") if isinstance(message, dict) else None
        # NB: `list` is shadowed by this module's agents.list() — the content
        # check below must not reference it (isinstance(x, list) would raise).
        if isinstance(content, str):
            text = content
        elif content is None:
            text = ""
        else:
            text = " ".join(
                str(b.get("text", "")) for b in content if isinstance(b, dict)
            )
        lines.append(f"[{role}] {text}" if role else text)
    read.messages = lines[-limit:] if limit is not None else lines
    return read
