"""`aegisx.queue` — the event's task queue (the plan)."""
from __future__ import annotations

from typing import Any

from .client import AegisxError, get_client
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
    client = get_client()
    data = client.request("GET", client.event_path("/queue"))
    items: QueueItemList = []
    for item in data.get("items", []):
        built = from_dict(QueueItem, item)
        if built is not None:
            items.append(built)
    return items


def state() -> str:
    """The queue's state: "running" | "paused"."""
    client = get_client()
    data = client.request("GET", client.event_path("/queue"))
    return data.get("state", "")


def enqueue(
    challenge_id: str,
    prompt: str | None = None,
    model: str | None = None,
    timeout_ms: int | None = None,
) -> QueueItem:
    """Append a spawn item in the queue — one challenge may hold several
    pending items (parallel attempts are a legal plan). The queue drains FIFO
    under the concurrency caps; with a free slot the agent spawns right away.

    `prompt` is the spawned agent's strategy (appended as a Strategy section;
    pass `prompt_mode="override"` server-side to replace the first prompt
    entirely). A capacity rejection stays pending (no failure); adjust the
    plan, do not retry blindly. Prefer this over `aegisx.agents.start` for
    planned work."""
    body: dict = {"challengeId": challenge_id}
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


def pause() -> None:
    """Pause the queue: blocks FUTURE launches only — running agents keep
    going (pause ≠ kill). Enqueue/edit/reorder/remove still work."""
    get_client().request(
        "POST", get_client().event_path("/queue/pause"), body={}
    )


def resume() -> None:
    """Resume the queue (re-enables the drainer)."""
    get_client().request(
        "POST", get_client().event_path("/queue/resume"), body={}
    )


def remove(item_id: str) -> None:
    """Remove a queue item (pending/done/cancelled/failed). A running item
    cannot be removed — close its agent first."""
    client = get_client()
    client.request("DELETE", client.event_path(f"/queue/{item_id}"))


def clear() -> None:
    """Remove every non-running queue item (pending + failed)."""
    client = get_client()
    client.request("POST", client.event_path("/queue/clear"), body={})


def reorder(item_ids: list[str]) -> None:
    """Reorder pending queue items by listing their ids front-first.
    Running/failed items keep their place."""
    client = get_client()
    client.request(
        "POST",
        client.event_path("/queue/reorder"),
        body={"itemIds": item_ids},
    )
