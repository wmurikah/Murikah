"""Phase 6 assistance provenance helpers. The canonical 0..5 validator stays in Phase 3."""
from __future__ import annotations

from typing import Any

from ..ai.outputs import ASSISTANCE_LEVEL_LABELS, validate_assistance_level


def assistance_event(
    *,
    internship_id: str,
    task_id: str = "",
    artifact_id: str = "",
    artifact_version_id: str = "",
    source: str,
    provenance: str,
    level: int,
    category: str,
    summary: str = "",
    model_invocation_id: str = "",
    event_time: int,
) -> dict[str, Any]:
    validated = validate_assistance_level(level)
    if source not in {"murikah_mentor", "external_declared", "approved_tool"}:
        raise ValueError("unknown assistance source")
    if provenance not in {"system_observed", "learner_declared"}:
        raise ValueError("unknown assistance provenance")
    expected_provenance = {
        "murikah_mentor": "system_observed",
        "approved_tool": "system_observed",
        "external_declared": "learner_declared",
    }[source]
    if provenance != expected_provenance:
        raise ValueError("assistance source and provenance do not match")
    return {
        "internship_id": internship_id,
        "task_id": task_id,
        "artifact_id": artifact_id,
        "artifact_version_id": artifact_version_id,
        "source": source,
        "provenance": provenance,
        "assistance_level": validated,
        "assistance_label": ASSISTANCE_LEVEL_LABELS[validated],
        "category": str(category or "")[:80],
        "summary": str(summary or "")[:1000],
        "model_invocation_id": model_invocation_id,
        "event_time": int(event_time),
    }


def events_before_submission(events: list[dict[str, Any]], *, submitted_at: int) -> list[dict[str, Any]]:
    return [
        event for event in events
        if isinstance(event, dict) and int(event.get("event_time") or 0) <= int(submitted_at)
    ]


__all__ = ["assistance_event", "events_before_submission"]
