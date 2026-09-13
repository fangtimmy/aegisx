"""`aegisx.queue` — the read view of the event's task queue.

The queue IS the plan's landing zone: `submit_plan` mutates it
(enqueue / cancel_item / reorder / set_queue_paused — see `aegisx.plan`).
This module is the read side: what the queue looks like right now is the
fastest feedback on what a plan just did.
"""
from __future__ import annotations

from .client import get_client
from .models import QueueItem, from_dict

#: Hoisted alias — the module-level name `list` shadows the builtin for
#: every later annotation, so annotations must not subscript `list` directly.
QueueItemList = list[QueueItem]


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
