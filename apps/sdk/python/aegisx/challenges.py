"""`aegisx.challenges` — read the event's challenge inventory."""
from __future__ import annotations

from .client import get_client
from .models import Challenge, from_dict


def list() -> list[Challenge]:
    """All challenges in the event (points, category, solved state, run
    activity). Use to pick what to work on; read full detail with
    `aegisx.challenges.get(id)`."""
    client = get_client()
    data = client.request("GET", client.event_path(""))
    return [
        from_dict(Challenge, item) for item in data.get("challenges", [])
    ]


def get(challenge_id: str) -> Challenge:
    """Full detail for one challenge: description, attachments, remote target
    connectivity (ports/services), solved state, and run history. Read this
    before starting a challenge you do not know."""
    data = get_client().request("GET", f"/api/challenges/{challenge_id}")
    return from_dict(Challenge, data)
