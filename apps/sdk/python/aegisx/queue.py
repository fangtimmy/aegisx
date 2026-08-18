"""`aegisx.queue` — the event's task queue (the plan)."""
from __future__ import annotations

from typing import Any

from .client import AegisxError, get_client, require_manager
from .models import QueueItem, from_dict

#: Hoisted aliases — the module-level name `list` shadows the builtin for
#: every later annotation, so annotations must not subscript `list` directly.
QueueItemList = list[QueueItem]


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
    prompt: str | None = None,
    model: str | None = None,
    timeout_ms: int | None = None,
    source: str = "scheduler",
) -> QueueItem:
    """Append a spawn item in the queue — one challenge may hold several
    pending items (parallel attempts are a legal plan). The queue drains FIFO
    under the concurrency caps; with a free slot the agent spawns right away.

    `prompt` is the spawned agent's strategy (appended as a Strategy section;
    pass `prompt_mode="override"` server-side to replace the first prompt
    entirely). A capacity rejection stays pending (no failure); adjust the
    plan, do not retry blindly. Prefer this over `aegisx.agents.start` for
    planned work.

    `source` marks who enqueued ("scheduler" by default — the SDK is the
    scheduler's face; pass "manual" only for user-driven scripts)."""
    require_manager()
    body: dict = {"challengeId": challenge_id, "source": source}
    if prompt:
        body["prompt"] = prompt
    if model:
        body["model"] = model
    if timeout_ms:
        body["timeoutMs"] = timeout_ms
    data = get_client().request(
        "POST", get_client().event_path("/queue"), body=body
    )
    return _item(data)


def remove(item_id: str) -> None:
    """Remove a queue item (pending/done/cancelled/failed). A running item
    cannot be removed — close its agent first."""
    require_manager()
    client = get_client()
    client.request("DELETE", client.event_path(f"/queue/{item_id}"))


def clear() -> None:
    """Remove every non-running queue item (pending + failed)."""
    require_manager()
    client = get_client()
    client.request("POST", client.event_path("/queue/clear"))


def reorder(item_ids: list[str]) -> None:
    """Reorder pending queue items by listing their ids front-first.
    Running/failed items keep their place."""
    require_manager()
    client = get_client()
    client.request(
        "POST",
        client.event_path("/queue/reorder"),
        body={"itemIds": item_ids},
    )
