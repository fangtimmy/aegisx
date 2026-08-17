"""`aegisx.runs` — challenge run lifecycle + reads."""
from __future__ import annotations

from builtins import list as builtin_list
from typing import Any

from .client import AegisxError, get_client, require_manager, wire_solvers
from .models import AgentSummary, ChannelMessage, Run, RunRead, from_dict

# Mirrors the server's read_run defaults (scheduler-admin.ts).
DEFAULT_LAST_N = 10
READ_CHAR_BUDGET = 12_000

#: Hoisted aliases — the module-level name `list` shadows the builtin for
#: every later annotation and isinstance call below.
RunList = list[Run]
AgentSummaries = list[AgentSummary]
RecentLines = list[str]
SolverSpecs = list[dict]


def _run(data: Any) -> Run:
    run = from_dict(Run, data)
    if run is None:
        raise AegisxError("bad_response", "malformed run payload")
    return run


def _msg(data: Any) -> ChannelMessage:
    message = from_dict(ChannelMessage, data)
    if message is None:
        raise AegisxError("bad_response", "malformed message payload")
    return message


def list(
    challenge_id: str | None = None,
    status: str | None = None,
) -> RunList:
    """Enumerate the event's challenge runs (recent first), optionally
    filtered by challenge or status (client-side — the endpoint has no filter
    params). Use to review history before re-trying a failed strategy."""
    client = get_client()
    data = client.request("GET", client.event_path("/runs"))
    runs: RunList = []
    for item in data.get("items", []):
        run = from_dict(Run, item)
        if run is not None:
            runs.append(run)
    if challenge_id:
        runs = [r for r in runs if r.challenge_id == challenge_id]
    if status:
        runs = [r for r in runs if r.status == status]
    return runs


def start(
    challenge_id: str,
    strategy: str | None = None,
    model: str | None = None,
    solver_count: int | None = None,
    solvers: SolverSpecs | None = None,
    timeout_ms: int | None = None,
) -> Run:
    """Start a fresh solver run directly (escape hatch — bypasses the queue).
    The `strategy` is per-run guidance — be specific. A concurrency/target-slot
    rejection comes back as AegisxError("capacity") — adjust the plan, do not
    retry blindly. Prefer `aegisx.queue.enqueue` for planned work."""
    require_manager()
    body: dict = {"challengeId": challenge_id}
    if strategy:
        body["strategy"] = strategy
    if model:
        body["model"] = model
    if solver_count:
        body["solver_count"] = solver_count
    solvers_wire = wire_solvers(solvers)
    if solvers_wire:
        body["solvers"] = solvers_wire
    if timeout_ms:
        body["timeoutMs"] = timeout_ms
    data = get_client().request("POST", "/api/runs/start", body=body)
    return _run(data)


def stop(run_id: str) -> Run:
    """Abort a run's current turn (→ idle; container kept warm). Use to cut a
    stuck or off-track running turn before messaging new direction."""
    require_manager()
    data = get_client().request("POST", f"/api/runs/{run_id}/stop")
    return _run(data)


def message(run_id: str, text: str, urgent: bool = True) -> ChannelMessage:
    """Send guidance to a run's ENTRY agent (v18 §9.3: an IM post into its
    dm:<agentId> channel — the run keeps a ledger of your directives).
    Default urgent=True wakes it immediately (a closed run is cold-restored,
    keeping context + workspace); urgent=False rides the next delivery
    tick. Use `aegisx.agents.message` to target a specific solver."""
    require_manager()
    entry = _entry_agent(run_id)
    data = get_client().request(
        "POST",
        f"/api/channels/dm:{entry}/messages",
        body={"text": text, "urgent": bool(urgent)},
    )
    return _msg(data)


def _entry_agent(run_id: str) -> str:
    """The run's entry agent id (message's dm target)."""
    detail = get_client().request("GET", f"/api/runs/{run_id}")
    for item in detail.get("agents", []):
        if item.get("isEntry"):
            return str(item.get("id", ""))
    raise AegisxError("not_found", f"Run {run_id} has no entry agent")


def close(run_id: str) -> Run:
    """Release a run's container (→ closed; session + history kept, resumable
    later with message). Use to free resources on runs you are pausing."""
    require_manager()
    data = get_client().request("POST", f"/api/runs/{run_id}/close")
    return _run(data)


def set_timeout(run_id: str, timeout_ms: int) -> Run:
    """Set or extend a run's hard deadline (milliseconds from now)."""
    require_manager()
    data = get_client().request(
        "POST", f"/api/runs/{run_id}/timeout", body={"timeoutMs": timeout_ms}
    )
    return _run(data)


def read(
    run_id: str,
    agent_id: str | None = None,
    last_n: int | None = None,
) -> RunRead:
    """Read a run's status and one agent's recent output (defaults to the
    entry agent; pass `agent_id` from `aegisx.agents.list` to read a specific
    solver). Returns the run + agents + the target agent's most recent
    rendered message lines (assistant text / tool one-liners / user text),
    newest kept, within a character budget."""
    client = get_client()
    detail = client.request("GET", f"/api/runs/{run_id}")
    run = _run(detail["run"])
    agents: AgentSummaries = []
    for item in detail.get("agents", []):
        summary = from_dict(AgentSummary, item)
        if summary is not None:
            agents.append(summary)
    target = _pick_agent(agents, agent_id)
    if target is None:
        raise AegisxError(
            "not_found", f"No agent found in run {run_id}"
        )
    messages = _recent_lines(
        client, run_id, target.id,
        last_n if last_n and last_n > 0 else DEFAULT_LAST_N,
    )
    return RunRead(run=run, agents=agents, agent=target, messages=messages)


def _pick_agent(
    agents: AgentSummaries, agent_id: str | None
) -> AgentSummary | None:
    if agent_id:
        return next((a for a in agents if a.id == agent_id), None)
    return next((a for a in agents if a.is_entry), None)


def _recent_lines(
    client, run_id: str, agent_id: str, last_n: int
) -> RecentLines:
    """Mirror the server's read_run message extraction (scheduler-admin.ts
    messageLine): newest → oldest, capped by last_n + a char budget, returned
    oldest-first."""
    data = client.request(
        "GET",
        f"/api/runs/{run_id}/messages",
        query={"agentId": agent_id},
    )
    lines: RecentLines = []
    budget = READ_CHAR_BUDGET
    for item in reversed(data.get("items", [])):
        line = _message_line(item)
        if not line:
            continue
        if len(lines) >= last_n or budget <= 0:
            break
        capped = line[:budget]
        lines.insert(0, capped)
        budget -= len(capped)
    return lines


def _text_parts(content) -> str:
    if isinstance(content, str):
        return content.strip()
    # `builtin_list` — the module-level `runs.list` shadows the builtin name.
    if not isinstance(content, builtin_list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    ).strip()


def _message_line(item: dict) -> str | None:
    """Render one message entry as a line (parity with the server's
    read_run output): `[assistant] body`, `[user] body`, `[tool name] head`."""
    entry = item.get("entry") or {}
    if entry.get("type") != "message":
        return None
    message = entry.get("message") or {}
    role = message.get("role")
    if role == "assistant":
        body = _text_parts(message.get("content"))
        if body:
            return f"[assistant] {body}"
        tools = [
            str(part["name"])
            for part in (message.get("content") or [])
            if isinstance(part, dict)
            and part.get("type") == "toolCall"
            and part.get("name")
        ]
        return f"[assistant] (tool calls: {', '.join(tools)})" if tools else None
    if role == "user":
        body = _text_parts(message.get("content"))
        return f"[user] {body}" if body else None
    if role == "toolResult":
        body = _text_parts(message.get("content"))
        head = next((line for line in body.split("\n") if line.strip()), "")
        return (
            f"[tool {message.get('toolName')}] "
            f"{head[:200] if head else '(no output)'}"
            f"{' (error)' if message.get('isError') else ''}"
        )
    return None
