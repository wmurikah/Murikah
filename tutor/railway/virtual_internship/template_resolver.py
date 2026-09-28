"""Deterministic publish-time scenario-template resolver for Virtual Internship Phase 10."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any

TEMPLATE_SCHEMA_VERSION = 1
MAX_INHERITANCE_DEPTH = 8
TEMPLATES_ROOT = Path(__file__).resolve().parents[2] / "virtual-internship" / "templates" / "v1"


class TemplateResolutionError(ValueError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def template_content_hash(template: dict[str, Any]) -> str:
    value = copy.deepcopy(template)
    value["content_hash"] = ""
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def resolved_content_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def load_templates(root: Path = TEMPLATES_ROOT) -> dict[tuple[str, int], dict[str, Any]]:
    templates: dict[tuple[str, int], dict[str, Any]] = {}
    for path in sorted(root.glob("*.json")):
        obj = json.loads(path.read_text(encoding="utf-8"))
        key = (str(obj.get("template_id") or ""), int(obj.get("template_version") or 0))
        if not key[0] or key[1] < 1:
            raise TemplateResolutionError(f"{path.name}: invalid template identity")
        if key in templates:
            raise TemplateResolutionError(f"duplicate template version {key[0]} v{key[1]}")
        if int(obj.get("schema_version") or 0) != TEMPLATE_SCHEMA_VERSION:
            raise TemplateResolutionError(f"{path.name}: incompatible schema version")
        if obj.get("status") not in {"published", "retired"}:
            raise TemplateResolutionError(f"{path.name}: invalid status")
        expected = template_content_hash(obj)
        if str(obj.get("content_hash") or "") != expected:
            raise TemplateResolutionError(f"{path.name}: expected content_hash {expected}")
        templates[key] = obj
    return templates


def _merge_object(parent: dict[str, Any], child: dict[str, Any], path: str) -> dict[str, Any]:
    out = copy.deepcopy(parent)
    for key, value in child.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_object(out[key], value, f"{path}.{key}")
        else:
            out[key] = copy.deepcopy(value)
    return out


def _merge_keyed(parent: list[Any], child: list[Any], key: str, path: str) -> list[Any]:
    rows: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for item in parent + child:
        if not isinstance(item, dict) or not item.get(key):
            raise TemplateResolutionError(f"{path}: keyed collection requires {key}")
        ident = str(item[key])
        if ident not in rows:
            order.append(ident)
            rows[ident] = copy.deepcopy(item)
        else:
            rows[ident] = _merge_object(rows[ident], item, path + "." + ident)
    return [rows[item] for item in order]


def _merge_sections(base: dict[str, Any], incoming: dict[str, Any], source: str) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for name, value in incoming.items():
        if name == "keyed_collections":
            for collection, spec in (value or {}).items():
                if not isinstance(spec, dict) or not spec.get("key"):
                    raise TemplateResolutionError(f"{source}: invalid keyed collection declaration")
                out[collection] = _merge_keyed(
                    out.get(collection, []),
                    spec.get("items", []),
                    str(spec["key"]),
                    collection,
                )
        elif isinstance(value, dict):
            out[name] = _merge_object(out.get(name, {}), value, name)
        else:
            out[name] = copy.deepcopy(value)
    return out


def _ref_key(ref: dict[str, Any]) -> tuple[str, int]:
    return str(ref.get("template_id") or ""), int(ref.get("template_version") or 0)


def _resolve_one(
    ref: dict[str, Any],
    templates: dict[tuple[str, int], dict[str, Any]],
    stack: tuple[tuple[str, int], ...],
    depth: int,
) -> dict[str, Any]:
    if depth > MAX_INHERITANCE_DEPTH:
        raise TemplateResolutionError("excessive inheritance depth")
    key = _ref_key(ref)
    tid, version = key
    if not tid or version < 1:
        raise TemplateResolutionError("invalid template reference")
    if key in stack:
        chain = " -> ".join(f"{item[0]} v{item[1]}" for item in (*stack, key))
        raise TemplateResolutionError(f"inheritance cycle: {chain}")
    template = templates.get(key)
    if not template:
        raise TemplateResolutionError(f"missing parent template {tid} v{version}")
    if template.get("status") != "published":
        raise TemplateResolutionError(f"unpublished parent template {tid} v{version}")
    if int(template.get("schema_version") or 0) != TEMPLATE_SCHEMA_VERSION:
        raise TemplateResolutionError(f"incompatible template schema version for {tid} v{version}")
    declared_hash = str(ref.get("content_hash") or "")
    actual_hash = str(template.get("content_hash") or "")
    if declared_hash != actual_hash:
        raise TemplateResolutionError(f"template hash mismatch {tid} v{version}")

    resolved: dict[str, Any] = {}
    parent_refs = template.get("parent_refs") or []
    if not isinstance(parent_refs, list):
        raise TemplateResolutionError(f"{tid} v{version}: parent_refs must be a list")
    parent_seen: set[tuple[str, int]] = set()
    for parent_ref in parent_refs:
        if not isinstance(parent_ref, dict):
            raise TemplateResolutionError(f"{tid} v{version}: invalid parent reference")
        parent_key = _ref_key(parent_ref)
        if parent_key in parent_seen:
            raise TemplateResolutionError(f"duplicate inherited template {parent_key[0]} v{parent_key[1]}")
        parent_seen.add(parent_key)
        resolved = _merge_sections(
            resolved,
            _resolve_one(parent_ref, templates, (*stack, key), depth + 1),
            f"{tid} v{version}",
        )
    return _merge_sections(resolved, template.get("sections") or {}, f"{tid} v{version}")


def resolve_template_sections(
    child: dict[str, Any],
    refs: list[dict[str, Any]],
    templates: dict[tuple[str, int], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Resolve exact published template versions using deterministic merge rules.

    Scalars and arrays supplied by the child replace inherited values. Object
    sections merge recursively only inside explicitly named template sections.
    Keyed collections merge only when a template declares the stable key.
    Required inherited values cannot be deleted because deletion semantics do
    not exist. Parent templates are resolved before the child template.
    """
    templates = templates or load_templates()
    if len(refs) > MAX_INHERITANCE_DEPTH:
        raise TemplateResolutionError("excessive inheritance depth")
    seen: set[tuple[str, int]] = set()
    resolved: dict[str, Any] = {}
    for ref in refs:
        key = _ref_key(ref)
        if key in seen:
            raise TemplateResolutionError(f"duplicate inherited template {key[0]} v{key[1]}")
        seen.add(key)
        resolved = _merge_sections(resolved, _resolve_one(ref, templates, tuple(), 1), key[0])
    return _merge_sections(resolved, child, "child scenario")


def resolve_scenario_pack(
    pack: dict[str, Any],
    templates: dict[tuple[str, int], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Materialize a complete scenario snapshot from its pinned template refs.

    The returned pack is independent of its parents and is the object that must
    be validated, hashed and persisted. Runtime internship reads never invoke
    this resolver.
    """
    out = copy.deepcopy(pack)
    manifest = out.get("manifest")
    if not isinstance(manifest, dict):
        raise TemplateResolutionError("scenario manifest is missing")
    refs = manifest.get("template_refs") or []
    if not refs:
        return out
    if not isinstance(refs, list) or any(not isinstance(ref, dict) for ref in refs):
        raise TemplateResolutionError("manifest.template_refs must be a list of pinned references")

    sections = resolve_template_sections({}, refs, templates)
    manifest_defaults = sections.get("manifest_defaults") or {}
    if not isinstance(manifest_defaults, dict):
        raise TemplateResolutionError("manifest_defaults must be an object")
    out["manifest"] = _merge_object(manifest_defaults, manifest, "manifest")

    catalog_defaults = sections.get("catalog_defaults") or {}
    if catalog_defaults:
        catalog = out["manifest"].get("catalog") or {}
        if not isinstance(catalog_defaults, dict) or not isinstance(catalog, dict):
            raise TemplateResolutionError("catalog_defaults and manifest.catalog must be objects")
        out["manifest"]["catalog"] = _merge_object(catalog_defaults, catalog, "manifest.catalog")

    task_defaults = sections.get("task_defaults") or {}
    if task_defaults:
        if not isinstance(task_defaults, dict):
            raise TemplateResolutionError("task_defaults must be an object")
        out["tasks"] = [
            _merge_object(task_defaults, task, f"tasks.{index}")
            for index, task in enumerate(out.get("tasks") or [])
        ]

    event_defaults = sections.get("event_defaults") or {}
    if event_defaults:
        if not isinstance(event_defaults, dict):
            raise TemplateResolutionError("event_defaults must be an object")
        out["events"] = [
            _merge_object(event_defaults, event, f"events.{index}")
            for index, event in enumerate(out.get("events") or [])
        ]

    for collection in ("actors", "facts", "tasks", "events", "decisions"):
        if collection in sections and collection not in {"task_defaults", "event_defaults"}:
            inherited = sections[collection]
            child_rows = out.get(collection) or []
            if inherited:
                stable_key = {
                    "actors": "actor_id",
                    "facts": "id",
                    "tasks": "task_id",
                    "events": "event_id",
                    "decisions": "decision_id",
                }[collection]
                out[collection] = _merge_keyed(inherited, child_rows, stable_key, collection)
    return out
