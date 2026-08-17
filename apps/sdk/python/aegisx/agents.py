"""`aegisx.agents` — agent-level addressing (v9)."""
from __future__ import annotations

from .client import AegisxError, get_client, require_manager
from .models import AgentSummary, ChannelMessage, Run, from_dict

#: Hoisted above `def list` — the module-level name shadows the builtin for
#: every later annotation.
AgentSummaries = list[AgentSummary]


def list(run_id: str | None = None) -> AgentSummaries:
    """Agents in a run (id, slot, role, model, status). Use to pick an agent
    id for `aegisx.runs.read` / `aegisx.agents.message`. `run_id` is required
    (the SDK has no run-scoped default)."""
    if not run_id:
        raise AegisxError(
            "no_run",
            "agents.list requires run_id= (the SDK does not know your own "
            "run id)",
        )
    detail = get_client().request("GET", f"/api/runs/{run_id}")
    items: AgentSummaries = []
    for item in detail.get("agents", []):
        summary = from_dict(AgentSummary, item)
        if summary is not None:
            items.append(summary)
    return items


def message(
    agent_id: str,
    text: str,
    urgent: bool = True,
    deliver_as: str | None = None,
) -> ChannelMessage:
    """Send guidance to one specific agent by id (v18: an IM post into its
    dm:<agentId> channel — the ledger keeps your directives). Default
    urgent=True: the target is woken immediately (streaming → steer at turn
    end; idle → fresh turn; a closed run is cold-restored keeping context +
    workspace — only that agent wakes). urgent=False merges into the next
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


def add(
    run_id: str,
    prompt: str,
    model: str | None = None,
    prompt_mode: str | None = None,
) -> Run:
    """Add one more solver to a run — its prompt is required (you add hands
    with a job). The new solver runs in parallel in the same
    container/workspace; a closed run is cold-restored first (existing solvers
    stay dormant until messaged). Use instead of a whole new run when a run
    needs another angle."""
    require_manager()
    body: dict = {"prompt": prompt}
    if model:
        body["model"] = model
    if prompt_mode:
        body["promptMode"] = prompt_mode
    data = get_client().request(
        "POST", f"/api/runs/{run_id}/agents", body=body
    )
    run = from_dict(Run, data)
    if run is None:
        raise AegisxError("bad_response", "malformed run payload")
    return run
