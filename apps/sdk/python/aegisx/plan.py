"""`aegisx.plan` — the scheduler's typed control surface (control-plane §B).

`submit_plan` is the ONE management write verb: you produce a typed plan
(rationale + actions), the server validates it, applies the fast actions
inline and defers the slow ones (stop/close/finish/cold wakes). Per-ref
validation errors come back in the same response (fix them and resubmit the
whole plan); deferred outcomes land in the plan.result decision-log entry.

Build actions with the module helpers — never hand-build JSON:

    import aegisx
    res = aegisx.submit_plan(
        "web-01 收官，预算转向 web-02",
        [aegisx.close("agent-a3f1"), aegisx.enqueue("ch-web02", prompt="...")],
    )
    for r in res.results:
        print(r.ref, r.kind, "ok" if r.ok else f"{r.code}: {r.message}")
    for d in res.deferred:
        print("deferred:", d.ref, d.kind)
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .client import get_client
from .errors import AegisxError
from .models import SubmitPlanResult, from_dict

#: Hoisted alias — module-level `list` shadows the builtin for the
#: annotation below.
Items = list[dict[str, Any]]


def _action(kind: str, ref: str | None = None, **fields: Any) -> dict[str, Any]:
    """One plan action dict. `ref` is optional — submit_plan derives missing
    refs from the action content, so re-running the same script after a
    timeout replays the SAME refs and the server dedupes idempotently."""
    action: dict[str, Any] = {"kind": kind, **fields}
    if ref:
        action["ref"] = ref
    return action


def enqueue(
    challenge_id: str,
    prompt: str | None = None,
    model: str | None = None,
    timeout_ms: int | None = None,
    ref: str | None = None,
) -> dict[str, Any]:
    """Append a spawn item (always append — parallel attempts are legal).
    Capacity is the drainer's business at launch; a fully-solved challenge
    (per the event's policy) rejects with code "solved_blocked"."""
    fields: dict[str, Any] = {"challengeId": challenge_id}
    if prompt is not None:
        fields["prompt"] = prompt
    if model is not None:
        fields["model"] = model
    if timeout_ms is not None:
        fields["timeoutMs"] = timeout_ms
    return _action("enqueue", ref, **fields)


def message(
    agent_id: str,
    text: str,
    urgent: bool = False,
    ref: str | None = None,
) -> dict[str, Any]:
    """Direct one agent: alive target → steer / fresh turn (fast); terminal
    target → cold wake keeping files + memory (deferred)."""
    fields: dict[str, Any] = {"agentId": agent_id, "text": text}
    if urgent:
        fields["urgent"] = True
    return _action("message", ref, **fields)


def stop(agent_id: str, ref: str | None = None) -> dict[str, Any]:
    """Abort a live agent's current turn (it settles to idle). Deferred —
    the wait is bounded; result lands in plan.result."""
    return _action("stop", ref, agentId=agent_id)


def close(agent_id: str, ref: str | None = None) -> dict[str, Any]:
    """Terminal-close a live agent (aborted; files + session survive) so it
    frees its concurrency slot. Deferred — result lands in plan.result."""
    return _action("close", ref, agentId=agent_id)


def finish(agent_id: str, summary: str, ref: str | None = None) -> dict[str, Any]:
    """Force-finish a live agent: terminal completed + summary — the
    sanctioned landing for a delivered result. Deferred."""
    return _action("finish", ref, agentId=agent_id, summary=summary)


def set_deadline(agent_id: str, timeout_ms: int, ref: str | None = None) -> dict[str, Any]:
    """Set / extend / shorten an agent's hard deadline (per-agent budget)."""
    return _action("setDeadline", ref, agentId=agent_id, timeoutMs=timeout_ms)


def cancel_item(item_id: str, ref: str | None = None) -> dict[str, Any]:
    """Cancel one pending queue item (stale work)."""
    return _action("cancelItem", ref, itemId=item_id)


def reorder(item_ids: list[str], ref: str | None = None) -> dict[str, Any]:
    """Reorder pending queue items by listing their ids front-first."""
    return _action("reorder", ref, itemIds=item_ids)


def set_queue_paused(paused: bool, ref: str | None = None) -> dict[str, Any]:
    """Pause / resume the queue (blocks future launches only)."""
    return _action("setQueuePaused", ref, paused=paused)


def no_op(reason: str, ref: str | None = None) -> dict[str, Any]:
    """Declare a deliberate pass — every decision must be explicit and
    auditable, including "do nothing"."""
    return _action("noOp", ref, reason=reason)


def _content_ref(entry: dict[str, Any]) -> str:
    """Stable ref derived from the action's content (ref excluded): the same
    action resubmitted after a timeout maps to the same ref, so the server's
    (scheduler, ref) dedup turns the retry into an idempotent replay instead
    of a double-apply."""
    material = {k: v for k, v in entry.items() if k != "ref"}
    digest = hashlib.sha256(
        json.dumps(material, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:12]
    return f"a{digest}"


def submit_plan(rationale: str, actions: Items) -> SubmitPlanResult:
    """Submit one typed plan (the scheduler's only management write). The
    server validates it synchronously: ANY per-ref error rejects the WHOLE
    plan — the response lists every ref's outcome (code + message), you fix
    the failing refs and resubmit. Validation errors are results, NOT
    exceptions; only a malformed envelope (HTTP 400) and auth errors raise
    AegisxError.

    `rationale` is the 1-3 sentence decision reason (decision log, never
    executed). `actions` is ordered — listing order IS application order.
    Fast actions are already applied when this returns (`queue_after` shows
    the resulting queue); slow ones (stop/close/finish/cold wakes) come back
    as `deferred` and report through plan.result.
    """
    if not rationale or not rationale.strip():
        raise AegisxError("invalid", "submit_plan requires a rationale")
    filled: Items = []
    used: set[str] = set()
    for action in actions:
        entry = dict(action)
        if not entry.get("ref"):
            base = _content_ref(entry)
            entry["ref"] = base
            suffix = 1
            while entry["ref"] in used:
                suffix += 1
                entry["ref"] = f"{base}-{suffix}"
        used.add(entry["ref"])
        filled.append(entry)
    data = get_client().request(
        "POST",
        get_client().event_path("/plan"),
        body={"rationale": rationale, "actions": filled},
    )
    result = from_dict(SubmitPlanResult, data)
    if result is None:
        raise AegisxError("bad_response", "malformed submit_plan payload")
    return result
