"""`aegisx.agents` — agent-level addressing (v19)."""
from __future__ import annotations

from .client import AegisxError, get_client, require_manager
from .models import AgentSummary, ChannelMessage, AgentRead, from_dict

#: Hoisted above `def list` — the module-level name shadows the builtin for
#: every later annotation.
AgentSummaries = list[AgentSummary]


def list(
    challenge_id: str | None = None,
    status: str | None = None,
) -> AgentSummaries:
    """Agents of the event, optionally scoped to one challenge / status.
    Use to pick an agent id for `aegisx.agents.read` / `aegisx.agents.message`.
    The scheduler agent (role=orchestrator, challenge_id=None) is included
    when no challenge filter is set."""
    require_manager()
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
    require_manager()
    data = get_client().request("GET", f"/api/agents/{agent_id}")
    read = from_dict(AgentRead, data)
    if read is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return read


def message(
    agent_id: str,
    text: str,
    urgent: bool = True,
    deliver_as: str | None = None,
) -> ChannelMessage:
    """Send guidance to one specific agent by id (an IM post into its
    dm:<agentId> channel — the ledger keeps your directives). Default
    urgent=True: the target is woken immediately (streaming → steer at turn
    end; idle → fresh turn; a terminal agent is reopened keeping files +
    memory — only that agent wakes). urgent=False merges into the next
    delivery tick. `deliver_as` steers ("steer") into or queues ("followUp")
    after a streaming turn."""
    require_manager()
    body: dict = {"text": text, "urgent": bool(urgent)}
    if deliver_as:
        body["deliverAs"] = deliver_as
    data = get_client().request(
        "POST", f"/api/channels/dm:{agent_id}/messages", body=body
    )
    message = from_dict(ChannelMessage, data)
    if message is None:
        raise AegisxError("bad_response", "malformed message payload")
    return message


def read(agent_id: str, last_n: int | None = None) -> AgentRead:
    """The agent detail + its recent message lines (rendered `[role] text`).
    Pass `last_n` to cap the tail."""
    require_manager()
    query: dict = {}
    if last_n is not None:
        query["limit"] = last_n
    client = get_client()
    detail = client.request("GET", f"/api/agents/{agent_id}")
    msgs = client.request("GET", f"/api/agents/{agent_id}/messages", query=query)
    read = from_dict(AgentRead, detail)
    if read is None:
        raise AegisxError("bad_response", "malformed agent payload")
    lines: list[str] = []
    for item in msgs.get("items", []):
        entry = item.get("entry", {})
        message = entry.get("message", {}) if isinstance(entry, dict) else {}
        role = message.get("role", "") if isinstance(message, dict) else ""
        content = message.get("content") if isinstance(message, dict) else None
        text = ""
        if isinstance(content, list):
            text = " ".join(
                str(b.get("text", "")) for b in content if isinstance(b, dict)
            )
        elif isinstance(content, str):
            text = content
        lines.append(f"[{role}] {text}" if role else text)
    read.messages = lines
    return read


def stop(agent_id: str) -> AgentSummary:
    """Abort the named agent's current turn (it settles to idle; the shared
    challenge container stays warm). Use before re-directing a stuck or
    off-track agent."""
    require_manager()
    data = get_client().request(
        "POST", f"/api/agents/{agent_id}/stop", body={}
    )
    summary = from_dict(AgentSummary, data)
    if summary is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return summary


def close(agent_id: str) -> AgentSummary:
    """Terminal close (aborted): files + session survive; a message reopens
    on demand. Use for agents you are done with so they stop occupying the
    agent cap."""
    require_manager()
    data = get_client().request(
        "POST", f"/api/agents/{agent_id}/close", body={}
    )
    summary = from_dict(AgentSummary, data)
    if summary is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return summary


def set_timeout(agent_id: str, timeout_ms: int) -> AgentSummary:
    """Set / extend / shorten the agent's hard deadline. Usable on a terminal
    agent (pre-sets the deadline for the next reopen)."""
    require_manager()
    data = get_client().request(
        "POST",
        f"/api/agents/{agent_id}/timeout",
        body={"timeoutMs": timeout_ms},
    )
    summary = from_dict(AgentSummary, data)
    if summary is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return summary


def start(
    challenge_id: str,
    prompt: str | None = None,
    model: str | None = None,
    timeout_ms: int | None = None,
    source: str = "scheduler",
) -> AgentSummary:
    """ESCAPE HATCH: spawn an agent on the challenge IMMEDIATELY (bypasses the
    queue — the fence cap rejects with code "capacity" when full). Prefer
    `aegisx.queue.enqueue` for ordinary planning. The agent's `prompt` is its
    strategy (appended as a Strategy section; `prompt_mode="override"` is the
    server-side field, not exposed here)."""
    require_manager()
    body: dict = {"source": source}
    if prompt:
        body["prompt"] = prompt
    if model:
        body["model"] = model
    if timeout_ms:
        body["timeoutMs"] = timeout_ms
    data = get_client().request(
        "POST", f"/api/challenges/{challenge_id}/agents", body=body
    )
    summary = from_dict(AgentSummary, data)
    if summary is None:
        raise AegisxError("bad_response", "malformed agent payload")
    return summary
