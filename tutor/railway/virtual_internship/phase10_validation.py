"""Phase 10 catalog and production-pack validation."""
from __future__ import annotations
from pathlib import Path
from typing import Any

from virtual_internship.template_resolver import (
    TemplateResolutionError,
    load_templates,
    resolve_template_sections,
)


def validate_phase10_pack(
    pack: dict[str, Any],
    pack_dir: Path,
    completion: dict[str, Any] | None,
    load_json,
    validate_schema,
    fail,
    catalog_schema_path: Path,
    career_families_path: Path,
) -> None:
    manifest = pack["manifest"]
    catalog = manifest.get("catalog")
    mode = str(manifest.get("mode") or ("standard" if manifest["qualifying"] else "demo"))
    physical = str(manifest.get("physical_competency_classification") or "")

    if physical and physical not in {"knowledge_work", "mixed", "physical_skill_limited"}:
        fail("manifest.physical_competency_classification", "invalid simulation-scope classification")
    if physical in {"mixed", "physical_skill_limited"} and not str(
        manifest.get("physical_competency_limitation_text") or ""
    ).strip():
        fail("manifest.physical_competency_limitation_text", "mixed or physical scope requires a limitation statement")

    if catalog is None:
        if manifest["qualifying"]:
            fail("manifest.catalog", "qualifying Phase 10 scenario requires catalog metadata")
        return

    catalog_schema = load_json(catalog_schema_path)
    validate_schema(catalog, catalog_schema, catalog_schema, "manifest.catalog")
    registry = load_json(career_families_path)
    family_ids = {
        row["id"] for row in registry.get("families", []) if row.get("active") is True
    }
    if catalog["career_family_id"] not in family_ids:
        fail("manifest.catalog.career_family_id", "unknown or inactive career family")
    if int(catalog["minimum_duration_days"]) != int(manifest["minimum_duration_days"]):
        fail("manifest.catalog.minimum_duration_days", "must match the scenario minimum duration")
    if str(catalog["physical_competency_classification"]) != (physical or "knowledge_work"):
        fail("manifest.catalog.physical_competency_classification", "must match the scenario classification")

    refs = manifest.get("template_refs", [])
    if refs:
        try:
            resolve_template_sections({}, refs, load_templates())
        except TemplateResolutionError as exc:
            fail("manifest.template_refs", str(exc))

    if manifest["qualifying"]:
        if mode != "standard" or catalog["internship_type"] != "qualifying":
            fail("manifest.mode", "qualifying catalog entries require standard mode")
        if completion is None:
            fail("completion.json", "qualifying Phase 10 scenario requires a completion policy")
        if len(pack["tasks"]) < 13:
            fail("tasks.json", "qualifying Phase 10 scenario must provide an approximately 13-week progression")
        if len(pack["actors"]) < 5:
            fail("actors.json", "qualifying Phase 10 scenario requires several workplace actors")
        if len(pack["events"]) < 14:
            fail("events.json", "qualifying Phase 10 scenario requires multi-week deterministic events")
        if not any(task.get("category") == "capstone" for task in pack["tasks"]):
            fail("tasks.json", "qualifying Phase 10 scenario requires a capstone")
        if not all(task.get("rubric") for task in pack["tasks"]):
            fail("tasks.json", "every qualifying task requires a Phase 6 rubric")
        if any(
            task.get("completion_criteria", {}).get("kind") == "trusted_internal_demo"
            for task in pack["tasks"]
        ):
            fail("tasks.json", "qualifying tasks cannot use demo completion semantics")
        if [str(task.get("allowed_mentor_support") or "") for task in pack["tasks"]][-2:] != ["none", "none"]:
            fail("tasks.json", "late qualifying work must demonstrate increasing independence")
        event_types = {str(event.get("event_type") or "") for event in pack["events"]}
        if "ethics_escalation" not in event_types:
            fail("events.json", "qualifying scenario requires an ethics and escalation event")
        if "workplace_dynamics" not in event_types:
            fail("events.json", "qualifying scenario requires a workplace-dynamics event")
        timed_meetings = [
            int(trigger.get("days"))
            for event in pack["events"]
            if event.get("event_type") == "meeting"
            for trigger in event.get("triggers", [])
            if trigger.get("trigger_type") == "time_elapsed_days" and isinstance(trigger.get("days"), int)
        ]
        if 45 not in timed_meetings:
            fail("events.json", "qualifying scenario requires a midpoint meeting")
        if not any(day >= 90 for day in timed_meetings):
            fail("events.json", "qualifying scenario requires a final review meeting")
    else:
        if mode != "demo" or catalog["internship_type"] != "practice":
            fail("manifest.mode", "catalog-visible non-qualifying scenarios must remain demo practice")
        if completion is not None:
            fail("completion.json", "practice internships must not install a qualifying completion policy")
        disclosure = str(catalog.get("completion_overview") or "").lower()
        if "does not" not in disclosure or "completion" not in disclosure:
            fail("manifest.catalog.completion_overview", "practice catalog must state non-qualification")
