"""Authored professional-judgment and escalation templates for Phase 6."""
from __future__ import annotations

from typing import Any

ETHICS_LIBRARY_VERSION = 1

_SCENARIOS = (
    ("conflict_of_interest", "A potential conflict of interest affects the assigned work."),
    ("soften_material_issue", "A stakeholder pressures the learner to ignore or soften a material issue."),
    ("confidentiality_privacy", "A request creates a confidentiality or privacy concern."),
    ("inappropriate_data_access", "A stakeholder requests access or data use beyond the authored procedure."),
    ("control_override", "A manager requests an undocumented control override."),
    ("questionable_reporting", "A reporting instruction conflicts with the available evidence."),
    ("policy_compliance_conflict", "A business request conflicts with an authored policy or compliance requirement."),
    ("safety_escalation", "A work decision raises a career-appropriate safety or escalation concern."),
    ("client_instruction_conflict", "A client or stakeholder instruction conflicts with the authored procedure."),
)


def _event(category: str, purpose: str) -> dict[str, Any]:
    return {
        "template_id": f"eth_{category}_v1",
        "library_version": ETHICS_LIBRARY_VERSION,
        "category": category,
        "learning_purpose": purpose,
        "allowed_options": [
            "ask_for_clarification",
            "document_issue",
            "consult_authored_policy",
            "raise_to_authored_supervisor",
            "use_authored_ethics_route",
            "decline_inappropriate_action",
        ],
        "consequence_authority": "phase2_authored_only",
    }


ETHICS_EVENTS = tuple(_event(category, purpose) for category, purpose in _SCENARIOS)


def validate_ethics_template(template: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "template_id", "library_version", "category", "learning_purpose",
        "allowed_options", "consequence_authority",
    }
    if not isinstance(template, dict) or set(template) != expected:
        raise ValueError("invalid ethics template")
    if template["library_version"] != ETHICS_LIBRARY_VERSION:
        raise ValueError("unsupported ethics library version")
    if template["consequence_authority"] != "phase2_authored_only":
        raise ValueError("ethics consequences must remain Phase 2 authored")
    if not template["allowed_options"] or len(set(template["allowed_options"])) != len(template["allowed_options"]):
        raise ValueError("ethics response options are invalid")
    return template


def validate_authored_option(template: dict[str, Any], option_id: str) -> str:
    validated = validate_ethics_template(template)
    if option_id not in validated["allowed_options"]:
        raise ValueError("unknown authored escalation option")
    return option_id


__all__ = ["ETHICS_EVENTS", "ETHICS_LIBRARY_VERSION", "validate_authored_option", "validate_ethics_template"]
