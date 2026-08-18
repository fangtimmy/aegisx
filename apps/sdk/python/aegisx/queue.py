"""`aegisx.queue` — the event's task queue (the plan)."""
from __future__ import annotations

from typing import Any

from .client import AegisxError, get_client, require_manager, wire_solvers
from .models import QueueItem, from_dict

#: Hoisted aliases — the module-level name `list` shadows the builtin for
#: every later annotation, so annotations must not subscript `list` directly
#: (same pattern as channels/runs/agents).
QueueItemList = list[QueueItem]
StrList = list[str]
SolverSpecs = list[dict]


def _item(data: Any) -> QueueItem:
    """from_dict narrowed to non-None (the server always sends the item)."""
    item = from_dict(QueueItem, data)
    if item is None:
        raise AegisxError("bad_response", "malformed queue item payload")
    return item


def list() -> QueueItemList:
    """The event's actionable queue items (pending + running + failed), FIFO.
    The queue content IS the plan."""
    require_manager()
    client = get_client()
    data = client.request("GET", client.event_path("/queue"))
    items: QueueItemList = []
    for item in data.get("items", []):
        built = from_dict(QueueItem, item)
        if built is not None:
            items.append(built)
    return items


def enqueue(
    challenge_id: str,
    strategy: str | None = None,
    model: str | None = None,
    solver_count: int | None = None,
    solvers: SolverSpecs | None = None,
    timeout_ms: int | None = None,
    source: str = "scheduler",
) -> QueueItem:
    """Add (or re-arm) a task in the queue — upserts by challenge; a hit
    including done/cancelled/failed resets to pending. The queue drains FIFO
    under the concurrency caps; with a free slot the run launches right away.

    `strategy` is the run-level guidance every solver receives. Shape the
    solver set with `model` / `solver_count` / `solvers` (per-solver
    {model?, prompt?, prompt_mode?}). A capacity rejection comes back as an
    AegisxError with code "capacity" — adjust the plan, do not retry blindly.
    Prefer this over `aegisx.runs.start` for planned work.

    `source` marks who enqueued ("scheduler" by default — the SDK is the
    scheduler's face; pass "manual" only for user-driven scripts)."""
    require_manager()
    body: dict = {"strategy": strategy} if strategy else {}
    if model:
        body["model"] = model
    if solver_count:
        body["solver_count"] = solver_count
    solvers_wire = wire_solvers(solvers)
    if solvers_wire:
        body["solvers"] = solvers_wire
    if timeout_ms:
        body["timeoutMs"] = timeout_ms
    if source:
        body["source"] = source
    data = get_client().request(
        "POST", f"/api/challenges/{challenge_id}/runs", body=body
    )
    return _item(data)


def remove(item_id: str) -> None:
    """Remove a queue item (pending/done/cancelled/failed). A running item
    cannot be removed — close its run first."""
    require_manager()
    client = get_client()
    client.request("DELETE", client.event_path(f"/queue/{item_id}"))


def clear() -> None:
    """Remove every non-running queue item (pending + failed)."""
    require_manager()
    client = get_client()
    client.request("POST", client.event_path("/queue/clear"))


def reorder(item_ids: StrList) -> None:
    """Reorder pending queue items by listing their ids front-first.
    Running/failed items keep their place."""
    require_manager()
    client = get_client()
    client.request(
        "POST",
        client.event_path("/queue/reorder"),
        body={"itemIds": item_ids},
    )
