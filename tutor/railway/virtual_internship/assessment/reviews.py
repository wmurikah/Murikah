"""Deterministic midpoint/final review eligibility and evidence snapshots."""
from __future__ import annotations

import hashlib
import json
from typing import Any

REVIEW_SNAPSHOT_VERSION = 1


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def resolved_review_days(manifest: dict[str, Any]) -> tuple[int, int]:
    minimum = max(1, _int(manifest.get("minimum_duration_days"), 90))
    policy = manifest.get("review_policy") if isinstance(manifest.get("review_policy"), dict) else {}
    midpoint = _int(policy.get("midpoint_day"), max(1, minimum // 2))
    final_day = _int(policy.get("final_review_day"), minimum)
    classification = str(manifest.get("classification") or "")
    if classification in {"demo", "test"}:
        midpoint = _int(policy.get("demo_accelerated_midpoint_day"), midpoint)
        final_day = _int(policy.get("demo_accelerated_final_day"), final_day)
    elif manifest.get("qualifying") is True or classification == "qualifying":
        # A qualifying final performance review may not become eligible before
        # the Phase 1 minimum duration. The review is still not completion.
        final_day = max(minimum, final_day)
    return max(1, midpoint), max(midpoint, final_day)


def review_eligibility(
    *,
    review_type: str,
    manifest: dict[str, Any],
    started_at: int,
    now: int,
) -> dict[str, Any]:
    if review_type not in {"midpoint", "final"}:
        raise ValueError("unknown performance review type")
    midpoint_day, final_day = resolved_review_days(manifest)
    required_day = midpoint_day if review_type == "midpoint" else final_day
    elapsed_days = max(0, (int(now) - int(started_at)) // 86400)
    return {
        "review_type": review_type,
        "eligible": elapsed_days >= required_day,
        "required_day": required_day,
        "elapsed_days": elapsed_days,
        "server_time": int(now),
    }


def build_review_snapshot(
    *,
    review_type: str,
    cutoff_at: int,
    assessments: list[dict[str, Any]],
    workflow_reviews: list[dict[str, Any]],
    reflections: list[dict[str, Any]],
    assistance_events: list[dict[str, Any]],
    activity: list[dict[str, Any]],
) -> dict[str, Any]:
    def before(rows: list[dict[str, Any]], keys: tuple[str, ...]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            stamp = next((_int(row.get(key)) for key in keys if _int(row.get(key)) > 0), 0)
            if stamp and stamp <= cutoff_at:
                out.append(row)
        return out
    snapshot = {
        "snapshot_version": REVIEW_SNAPSHOT_VERSION,
        "review_type": review_type,
        "cutoff_at": int(cutoff_at),
        "assessments": before(assessments, ("completed_at", "created_at")),
        "workflow_reviews": before(workflow_reviews, ("created_at",)),
        "reflections": before(reflections, ("updated_at", "created_at")),
        "assistance_events": before(assistance_events, ("event_time",)),
        "activity": before(activity, ("event_time", "created_at")),
    }
    raw = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    snapshot["snapshot_hash"] = hashlib.sha256(raw).hexdigest()
    return snapshot


def deterministic_review_findings(snapshot: dict[str, Any]) -> dict[str, Any]:
    strengths: list[dict[str, str]] = []
    development: list[dict[str, str]] = []
    priorities: list[dict[str, str]] = []
    for assessment in snapshot.get("assessments", []):
        if not isinstance(assessment, dict) or assessment.get("status") != "completed":
            continue
        assessment_id = str(assessment.get("id") or assessment.get("assessment_id") or "")
        for criterion in assessment.get("criteria", []) if isinstance(assessment.get("criteria"), list) else []:
            if not isinstance(criterion, dict):
                continue
            feedback = str(criterion.get("feedback") or "").strip()
            if not feedback:
                continue
            ref = {"assessment_id": assessment_id, "criterion_id": str(criterion.get("criterion_id") or "")}
            if criterion.get("result_state") == "assessed" and str(criterion.get("rating_id") or "") in {"meets", "exceeds"}:
                strengths.append({"text": feedback[:1000], **ref})
            elif criterion.get("result_state") == "assessed":
                development.append({"text": feedback[:1000], **ref})
                priorities.append({"text": f"Address the documented gap for {ref['criterion_id']}.", **ref})
    level_counts = {str(i): 0 for i in range(6)}
    for event in snapshot.get("assistance_events", []):
        level = _int(event.get("assistance_level"), -1) if isinstance(event, dict) else -1
        if 0 <= level <= 5:
            level_counts[str(level)] += 1
    narrative_parts = []
    if strengths:
        narrative_parts.append(f"{len(strengths)} evidence-grounded strength item(s) were identified.")
    if development:
        narrative_parts.append(f"{len(development)} evidence-grounded development item(s) were identified.")
    if not narrative_parts:
        narrative_parts.append("The available durable evidence does not yet support a detailed performance narrative.")
    return {
        "strengths": strengths[:12],
        "development_areas": development[:12],
        "priorities": priorities[:12],
        "assistance_summary": {"event_counts_by_level": level_counts},
        "narrative": " ".join(narrative_parts),
    }


__all__ = [
    "REVIEW_SNAPSHOT_VERSION",
    "build_review_snapshot",
    "deterministic_review_findings",
    "resolved_review_days",
    "review_eligibility",
]
