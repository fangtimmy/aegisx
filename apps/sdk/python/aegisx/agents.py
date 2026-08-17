"""`aegisx.agents` — agent-level addressing (v9)."""
from __future__ import annotations

from .client import AegisxError, get_client, require_manager
from .models import AgentSummary, Run, from_dict


def list(run_id: str | None = None) -> list[AgentSummary]:
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
    return [
        from_dict(AgentSummary, item) for item in detail.get("agents", [])
    ]


def message(agent_id: str, text: str, deliver_as: str | None = None) -> Run:
    """Send guidance to one specific agent by id, in any run. On an idle or
    closed agent this starts/continues its turn (a closed run is
    cold-restored, keeping context + workspace — only that agent wakes); on a
    running agent `deliver_as` steers ("steer") into or queues ("followUp")
    after the current turn."""
    require_manager()
    body: dict = {"text": text}
    if deliver_as:
        body["deliverAs"] = deliver_as
    data = get_client().request(
        "POST", f"/api/agents/{agent_id}/message", body=body
    )
    return from_dict(Run, data)


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
    return from_dict(Run, data)
