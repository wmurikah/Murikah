"""Role-specific, bounded Phase 3 context construction over Phase 2 safe views."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable

from .outputs import validate_assistance_level
from .roles import INTERNSHIP_CONTEXT_MAX_CHARS, INTERNSHIP_RECENT_TURNS


def _portable_message(item: Any) -> dict[str, str] | None:
    if not isinstance(item, dict):
        return None
    role = str(item.get("role") or "").strip().lower()
    content = str(item.get("content") or "").strip()
    if role not in {"user", "assistant"} or not content:
        return None
    return {"role": role, "content": content}


def bounded_conversation(messages: Iterable[dict[str, Any]] | None) -> list[dict[str, str]]:
    rows = [row for row in (_portable_message(item) for item in (messages or [])) if row]
    try:
        from deeptutor.murikah_context_packet import build_context_packet
        packet = build_context_packet(rows, max_chars=INTERNSHIP_CONTEXT_MAX_CHARS, recent_turns=INTERNSHIP_RECENT_TURNS)
        bounded: list[dict[str, str]] = []
        for item in packet:
            if not isinstance(item, dict) or not isinstance(item.get("content"), str):
                continue
            if item.get("role") == "system":
                bounded.append({"role": "memory", "content": item["content"]})
                continue
            row = _portable_message(item)
            if row:
                bounded.append(row)
        return bounded
    except Exception:
        selected: list[dict[str, str]] = []
        used = 0
        for row in reversed(rows[-INTERNSHIP_RECENT_TURNS * 2 :]):
            size = len(row["content"])
            if selected and used + size > INTERNSHIP_CONTEXT_MAX_CHARS:
                break
            selected.append(row)
            used += size
        selected.reverse()
        return selected


def _definition_payload(service: Any, account_actor_id: str, internship_id: str) -> dict[str, Any]:
    result = service.definition(account_actor_id, internship_id)
    definition = result.get("definition") if isinstance(result, dict) else None
    return definition if isinstance(definition, dict) else {}


def _task_context(definition: dict[str, Any], learner_view: dict[str, Any], task_id: str | None) -> dict[str, Any] | None:
    runtime = {str(t.get("task_id")): t for t in learner_view.get("tasks", []) if isinstance(t, dict)}
    if not task_id:
        candidates = [tid for tid, row in runtime.items() if row.get("status") in {"available", "in_progress"}]
        task_id = candidates[0] if candidates else None
    if not task_id:
        return None
    authored = next((t for t in definition.get("tasks", []) if isinstance(t, dict) and t.get("task_id") == task_id), None)
    current = runtime.get(task_id)
    if not authored or not current:
        return None
    return {
        "task_id": task_id,
        "title": authored.get("title"),
        "category": authored.get("category"),
        "business_context": authored.get("business_context"),
        "learner_objective": authored.get("learner_objective"),
        "brief": authored.get("brief"),
        "allowed_tools": authored.get("allowed_tools", []),
        "allowed_mentor_support": authored.get("allowed_mentor_support"),
        "stakeholder_actor_ids": authored.get("stakeholder_actor_ids", []),
        "status": current.get("status"),
        "due_at": current.get("due_at"),
    }


def build_actor_context(
    service: Any,
    *,
    account_actor_id: str,
    internship_id: str,
    scenario_actor_id: str,
    learner_message: str,
    conversation: Iterable[dict[str, Any]] | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    actor_result = service.actor_view(account_actor_id, internship_id, scenario_actor_id)
    actor_view = actor_result.get("view") if isinstance(actor_result, dict) else None
    if not isinstance(actor_view, dict):
        raise ValueError("actor view unavailable")
    learner_result = service.learner_view(account_actor_id, internship_id)
    learner_view = learner_result.get("view") if isinstance(learner_result, dict) else {}
    definition = _definition_payload(service, account_actor_id, internship_id)
    authored_actor = next((a for a in definition.get("actors", []) if isinstance(a, dict) and a.get("actor_id") == scenario_actor_id), {})
    return {
        "context_type": "workplace_actor",
        "internship_id": internship_id,
        "scenario_version_id": learner_view.get("scenario_version_id"),
        "actor": {
            **(actor_view.get("actor") if isinstance(actor_view.get("actor"), dict) else {}),
            "authority": authored_actor.get("authority", []),
            "goals": authored_actor.get("goals", []),
            "communication_style": authored_actor.get("communication_style", {}),
            "learner_relationship": authored_actor.get("learner_relationship", ""),
        },
        "known_facts": list(actor_view.get("facts") or []),
        "task": _task_context(definition, learner_view, task_id),
        "revealed_event_history": list(learner_view.get("fired_events") or []),
        "conversation_memory": bounded_conversation(conversation),
        "learner_message": str(learner_message or "")[:8000],
    }


def build_mentor_context(
    service: Any,
    *,
    account_actor_id: str,
    internship_id: str,
    learner_question: str,
    assistance_level: int,
    conversation: Iterable[dict[str, Any]] | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    level = validate_assistance_level(assistance_level)
    learner_result = service.learner_view(account_actor_id, internship_id)
    learner_view = learner_result.get("view") if isinstance(learner_result, dict) else None
    if not isinstance(learner_view, dict):
        raise ValueError("learner view unavailable")
    definition = _definition_payload(service, account_actor_id, internship_id)
    return {
        "context_type": "murikah_mentor",
        "internship_id": internship_id,
        "scenario_version_id": learner_view.get("scenario_version_id"),
        "learner_visible_facts": list(learner_view.get("facts") or []),
        "task": _task_context(definition, learner_view, task_id),
        "assistance_level": level,
        "mentor_conversation_memory": bounded_conversation(conversation),
        "learner_question": str(learner_question or "")[:8000],
    }


def build_assessor_context(
    service: Any,
    *,
    account_actor_id: str,
    internship_id: str,
    task_id: str,
    criteria: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    assistance_level: int,
) -> dict[str, Any]:
    level = validate_assistance_level(assistance_level)
    learner_result = service.learner_view(account_actor_id, internship_id)
    learner_view = learner_result.get("view") if isinstance(learner_result, dict) else None
    if not isinstance(learner_view, dict):
        raise ValueError("learner view unavailable")
    definition = _definition_payload(service, account_actor_id, internship_id)
    return {
        "context_type": "assessor_infrastructure_test",
        "internship_id": internship_id,
        "scenario_version_id": learner_view.get("scenario_version_id"),
        "task": _task_context(definition, learner_view, task_id),
        "criteria": criteria,
        "evidence": evidence,
        "assistance_level": level,
        "permitted_scenario_facts": list(learner_view.get("facts") or []),
    }



def build_formal_assessor_context(
    service: Any,
    *,
    account_actor_id: str,
    internship_id: str,
    task_id: str,
    assessment_id: str,
    rubric: dict[str, Any],
    evidence_packet: dict[str, Any],
    assistance_events: list[dict[str, Any]] | None = None,
    workflow_feedback: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build identity-minimized Phase 6 assessment context.

    Account identity is used only to authorize the safe Phase 2 views. It is not
    copied into the model context, and preferred name/email/profile metadata are
    deliberately absent.
    """
    learner_result = service.learner_view(account_actor_id, internship_id)
    learner_view = learner_result.get("view") if isinstance(learner_result, dict) else None
    if not isinstance(learner_view, dict):
        raise ValueError("learner view unavailable")
    definition = _definition_payload(service, account_actor_id, internship_id)
    task = _task_context(definition, learner_view, task_id)
    if not isinstance(task, dict):
        raise ValueError("assessment task unavailable")
    return {
        "context_type": "formal_assessment",
        "assessment_id": str(assessment_id or "")[:128],
        "internship_id": internship_id,
        "scenario_version_id": learner_view.get("scenario_version_id"),
        "task": task,
        "rubric": rubric,
        "evidence_packet": evidence_packet,
        "assistance_events": [
            {
                "source": str(row.get("source") or "")[:40],
                "provenance": str(row.get("provenance") or "")[:40],
                "assistance_level": validate_assistance_level(row.get("assistance_level")),
                "category": str(row.get("category") or "")[:80],
                "event_time": int(row.get("event_time") or 0),
            }
            for row in (assistance_events or [])
            if isinstance(row, dict)
        ][:64],
        "prior_workflow_feedback": [
            {
                "decision": str(row.get("decision") or "")[:40],
                "feedback": str(row.get("feedback") or "")[:2000],
                "requested_changes": [
                    str(item)[:500] for item in (row.get("requested_changes") or [])
                    if isinstance(item, str)
                ][:12],
            }
            for row in (workflow_feedback or [])
            if isinstance(row, dict)
        ][-3:],
        "permitted_scenario_facts": list(learner_view.get("facts") or []),
        "context_exclusions": [
            "preferred_name",
            "email",
            "account_profile",
            "private_mentor_conversation",
            "unrelated_tasks",
            "unrelated_inbox_messages",
            "sensitive_personal_profile_fields",
        ],
    }


def build_scenario_director_context(
    service: Any,
    *,
    account_actor_id: str,
    internship_id: str,
    task_id: str | None = None,
) -> dict[str, Any]:
    learner_result = service.learner_view(account_actor_id, internship_id)
    learner_view = learner_result.get("view") if isinstance(learner_result, dict) else None
    if not isinstance(learner_view, dict):
        raise ValueError("learner view unavailable")
    definition = _definition_payload(service, account_actor_id, internship_id)
    events = [
        {
            "event_id": e.get("event_id"),
            "event_type": e.get("event_type"),
            "priority": e.get("priority"),
            "audit_label": e.get("audit_label"),
            "actor_ids": e.get("actor_ids", []),
        }
        for e in definition.get("events", [])
        if isinstance(e, dict)
    ]
    decisions = [
        {
            "decision_id": d.get("decision_id"),
            "label": d.get("label"),
            "options": [
                {"option_id": o.get("option_id"), "label": o.get("label")}
                for o in d.get("options", [])
                if isinstance(o, dict)
            ],
        }
        for d in definition.get("decisions", [])
        if isinstance(d, dict)
    ]
    return {
        "context_type": "scenario_director",
        "internship_id": internship_id,
        "scenario_version_id": learner_view.get("scenario_version_id"),
        "task": _task_context(definition, learner_view, task_id),
        "current_learner_safe_state": {
            "facts": list(learner_view.get("facts") or []),
            "tasks": list(learner_view.get("tasks") or []),
            "fired_events": list(learner_view.get("fired_events") or []),
        },
        "authored_event_choices": events,
        "authored_decisions": decisions,
    }


def normalized_context_hash(context: dict[str, Any]) -> str:
    payload = json.dumps(context, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


__all__ = [
    "bounded_conversation",
    "build_actor_context",
    "build_assessor_context",
    "build_formal_assessor_context",
    "build_mentor_context",
    "build_scenario_director_context",
    "normalized_context_hash",
]
