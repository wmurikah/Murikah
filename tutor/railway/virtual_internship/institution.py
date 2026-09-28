"""Trusted institution scenario authoring workflow for Virtual Internship Phase 10.

This module is deliberately server-side. Learners never publish scenario state.
Drafts are declarative JSON, resolved through pinned templates, validated by the
same canonical pack validator used by repository scenarios, and only then
staged into immutable D1 scenario-version storage.
"""
from __future__ import annotations

import copy
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from virtual_internship.completion.policy import (
    COMPLETION_POLICY_FILENAME,
    completion_policy_hash,
)
from virtual_internship.template_resolver import resolve_scenario_pack
from virtual_internship.validator import (
    COMPONENTS,
    COMPONENT_FILES,
    content_hash,
    validate_pack,
)

FORBIDDEN_EXECUTABLE_KEYS = {
    "pythoncode",
    "javascriptcode",
    "executablecode",
    "scriptbody",
    "shellcommand",
    "powershellcommand",
    "binarypayload",
}


class InstitutionScenarioError(ValueError):
    pass


@dataclass(frozen=True)
class ValidatedInstitutionScenario:
    pack: dict[str, Any]
    completion_policy: dict[str, Any] | None
    content_hash: str


def _normalized_key(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalpha())


def _reject_executable_payload(value: Any, path: str = "draft") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            _reject_executable_payload(item, f"{path}[{index}]")
        return
    if not isinstance(value, dict):
        return
    for key, child in value.items():
        if _normalized_key(str(key)) in FORBIDDEN_EXECUTABLE_KEYS:
            raise InstitutionScenarioError(f"{path}.{key}: executable payloads are not allowed")
        _reject_executable_payload(child, f"{path}.{key}")


def _pack_from_draft(draft: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    if not isinstance(draft, dict) or not draft:
        raise InstitutionScenarioError("institution draft must be a non-empty object")
    _reject_executable_payload(draft)
    raw_pack = draft.get("pack")
    if raw_pack is None:
        raw_pack = {name: draft.get(name) for name in COMPONENTS}
    if not isinstance(raw_pack, dict):
        raise InstitutionScenarioError("institution draft pack must be an object")
    missing = [name for name in COMPONENTS if not isinstance(raw_pack.get(name), (dict, list))]
    if missing:
        raise InstitutionScenarioError("institution draft is missing: " + ", ".join(missing))
    pack = {name: copy.deepcopy(raw_pack[name]) for name in COMPONENTS}
    completion = draft.get("completion_policy", draft.get("completion"))
    if completion is not None and not isinstance(completion, dict):
        raise InstitutionScenarioError("completion policy must be an object")
    return pack, copy.deepcopy(completion) if isinstance(completion, dict) else None


def validate_institution_draft(draft: dict[str, Any]) -> ValidatedInstitutionScenario:
    """Resolve templates, hash the complete snapshot and run canonical validation."""
    pack, completion = _pack_from_draft(draft)
    resolved = resolve_scenario_pack(pack)
    manifest = resolved.get("manifest")
    if not isinstance(manifest, dict):
        raise InstitutionScenarioError("scenario manifest is missing")
    manifest["content_hash"] = ""
    digest = content_hash(resolved)
    manifest["content_hash"] = digest

    with tempfile.TemporaryDirectory(prefix="muri-phase10-institution-") as temp:
        root = Path(temp)
        for name in COMPONENTS:
            (root / COMPONENT_FILES[name]).write_text(
                json.dumps(resolved[name], ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        if completion is not None:
            (root / COMPLETION_POLICY_FILENAME).write_text(
                json.dumps(completion, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        validate_pack(root, verify_hash=True)
    return ValidatedInstitutionScenario(resolved, completion, digest)


def _persistence():
    from deeptutor import murikah_persistence
    return murikah_persistence


def _bridge_get(path: str) -> dict[str, Any]:
    persistence = _persistence()
    _status, raw, _headers = persistence._request("GET", path)
    value = json.loads(raw.decode("utf-8")) if raw else {}
    if not isinstance(value, dict):
        raise InstitutionScenarioError("institution persistence response is invalid")
    return value


def get_draft(actor_id: str, draft_id: str) -> dict[str, Any]:
    persistence = _persistence()
    query = urlencode({"actor_id": actor_id, "draft_id": draft_id})
    return _bridge_get(f"{persistence.PERSIST_PREFIX}/institution-scenarios/get?{query}")


def create_draft(actor_id: str, draft_id: str, draft: dict[str, Any]) -> dict[str, Any]:
    _reject_executable_payload(draft)
    return _persistence().institution_scenario_draft(actor_id, draft_id, draft)


def validate_saved_draft(actor_id: str, draft_id: str) -> dict[str, Any]:
    persistence = _persistence()
    stored = get_draft(actor_id, draft_id)
    record = stored.get("draft") if isinstance(stored, dict) else None
    source = record.get("draft") if isinstance(record, dict) else None
    if not isinstance(source, dict):
        raise InstitutionScenarioError("institution draft is not available")
    try:
        validated = validate_institution_draft(source)
    except Exception as exc:
        persistence.institution_scenario_validation(
            actor_id,
            draft_id,
            valid=False,
            validation={"valid": False, "error": str(exc)[:2000], "validator": "canonical-pack-v1"},
        )
        raise
    persistence.institution_scenario_validation(
        actor_id,
        draft_id,
        valid=True,
        validation={
            "valid": True,
            "validator": "canonical-pack-v1",
            "template_resolution": "phase10-pinned-template-v1",
            "scenario_version_id": validated.pack["manifest"]["scenario_version_id"],
        },
        resolved_content_hash=validated.content_hash,
    )
    return {
        "ok": True,
        "draft_id": draft_id,
        "status": "validated",
        "resolved_content_hash": validated.content_hash,
        "scenario_version_id": validated.pack["manifest"]["scenario_version_id"],
    }


def _bridge_post(route: str, payload: dict[str, Any]) -> dict[str, Any]:
    persistence = _persistence()
    return persistence._json_request("POST", f"{persistence.PERSIST_PREFIX}{route}", payload)


def publish_saved_draft(actor_id: str, draft_id: str) -> dict[str, Any]:
    """Publish a validated draft using a retry-safe staged sequence.

    A failure before catalog projection leaves an immutable validated/staged
    version that is not learner-startable. Repeating this function is safe:
    definition and completion-policy installation are idempotent by hash, and
    catalog projection is an upsert before the draft is marked published.
    """
    persistence = _persistence()
    stored = get_draft(actor_id, draft_id)
    record = stored.get("draft") if isinstance(stored, dict) else None
    if not isinstance(record, dict) or record.get("status") != "validated":
        raise InstitutionScenarioError("institution draft must be validated before publishing")
    source = record.get("draft")
    if not isinstance(source, dict):
        raise InstitutionScenarioError("institution draft content is unavailable")
    validated = validate_institution_draft(source)
    if validated.content_hash != str(record.get("resolved_content_hash") or ""):
        raise InstitutionScenarioError("validated draft content changed before publication")

    manifest = validated.pack["manifest"]
    catalog = manifest.get("catalog") if isinstance(manifest.get("catalog"), dict) else {}
    qualifying = manifest.get("qualifying") is True
    if qualifying and validated.completion_policy is None:
        raise InstitutionScenarioError("qualifying scenarios require a completion policy")

    stage = _bridge_post(
        "/institution-scenarios/stage",
        {
            "actor_id": actor_id,
            "draft_id": draft_id,
            "scenario_pack_id": manifest["id"],
            "scenario_slug": manifest["slug"],
            "scenario_version_id": manifest["scenario_version_id"],
            "scenario_version": manifest["scenario_version"],
            "title": manifest["title"],
            "career_family": manifest["career_family"],
            "role_title": manifest["role_title"],
            "minimum_duration_days": manifest["minimum_duration_days"],
            "expected_workload_band": manifest["expected_workload_band"],
            "content_hash": validated.content_hash,
        },
    )
    if not stage.get("ok"):
        raise InstitutionScenarioError("institution scenario staging failed")

    persistence.scenario_definition_install(
        str(manifest["scenario_version_id"]),
        validated.pack,
        content_hash=validated.content_hash,
    )
    if validated.completion_policy is not None:
        persistence.scenario_completion_policy_install(
            str(manifest["scenario_version_id"]),
            validated.completion_policy,
            policy_hash=completion_policy_hash(validated.completion_policy),
        )

    _bridge_post(
        "/institution-scenarios/activate",
        {
            "actor_id": actor_id,
            "draft_id": draft_id,
            "scenario_version_id": manifest["scenario_version_id"],
        },
    )
    persistence.internship_catalog_project(str(manifest["scenario_version_id"]))
    final = persistence.institution_scenario_publish_state(
        actor_id,
        draft_id,
        scenario_pack_id=str(manifest["id"]),
        scenario_version_id=str(manifest["scenario_version_id"]),
    )
    return {
        **final,
        "content_hash": validated.content_hash,
        "catalog_slug": str(catalog.get("catalog_slug") or final.get("catalog_slug") or ""),
    }


def retire_published_scenario(actor_id: str, draft_id: str) -> dict[str, Any]:
    return _persistence().institution_scenario_retire(actor_id, draft_id)
