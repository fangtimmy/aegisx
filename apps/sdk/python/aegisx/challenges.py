"""`aegisx.challenges` — read the event's challenge inventory."""
from __future__ import annotations

from .client import AegisxError, get_client
from .models import Challenge, from_dict

#: Hoisted above `def list` — the module-level name `list` shadows the builtin
#: for every later annotation, so annotations must not subscript `list`
#: directly (same pattern as channels/runs/agents).
ChallengeList = list[Challenge]


def list() -> ChallengeList:
    """All challenges in the event (points, category, solved state, agent
    activity). Use to pick what to work on; read full detail with
    `aegisx.challenges.get(id)`."""
    client = get_client()
    data = client.request("GET", client.event_path(""))
    challenges: ChallengeList = []
    for item in data.get("challenges", []):
        built = from_dict(Challenge, item)
        if built is not None:
            challenges.append(built)
    return challenges


def get(challenge_id: str) -> Challenge:
    """Full detail for one challenge: description, attachments, remote target
    connectivity (ports/services), solved state, and attempt history. Read
    this before starting a challenge you do not know."""
    data = get_client().request("GET", f"/api/challenges/{challenge_id}")
    challenge = from_dict(Challenge, data)
    if challenge is None:
        raise AegisxError("bad_response", "malformed challenge payload")
    return challenge
