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


def resolve_template_sections(
    child: dict[str, Any],
    refs: list[dict[str, Any]],
    templates: dict[tuple[str, int], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Resolve pinned parents.

    Scalar child values override parent values. Object sections merge recursively
    only inside declared sections. Arrays replace by default. A template may
    explicitly declare a keyed collection and its stable key. Required published
    template invariants cannot be deleted because deletion semantics do not exist.
    """
    templates = templates or load_templates()
    if len(refs) > MAX_INHERITANCE_DEPTH:
        raise TemplateResolutionError("excessive inheritance depth")
    seen: set[tuple[str, int]] = set()
    resolved: dict[str, Any] = {}
    for ref in refs:
        tid = str(ref.get("template_id") or "")
        version = int(ref.get("template_version") or 0)
        key = (tid, version)
        if key in seen:
            raise TemplateResolutionError(f"inheritance cycle or duplicate reference {tid} v{version}")
        seen.add(key)
        template = templates.get(key)
        if not template:
            raise TemplateResolutionError(f"missing parent template {tid} v{version}")
        if template.get("status") != "published":
            raise TemplateResolutionError(f"unpublished parent template {tid} v{version}")
        if int(template.get("schema_version") or 0) != TEMPLATE_SCHEMA_VERSION:
            raise TemplateResolutionError("incompatible template schema version")
        if str(ref.get("content_hash") or "") != str(template.get("content_hash") or ""):
            raise TemplateResolutionError(f"template hash mismatch {tid} v{version}")
        for name, value in (template.get("sections") or {}).items():
            if name == "keyed_collections":
                for collection, spec in (value or {}).items():
                    if not isinstance(spec, dict) or "key" not in spec:
                        raise TemplateResolutionError(f"{tid}: invalid keyed collection declaration")
                    resolved[collection] = _merge_keyed(
                        resolved.get(collection, []),
                        spec.get("items", []),
                        str(spec["key"]),
                        collection,
                    )
            elif isinstance(value, dict):
                resolved[name] = _merge_object(resolved.get(name, {}), value, name)
            else:
                resolved[name] = copy.deepcopy(value)
    for name, value in child.items():
        if isinstance(value, dict) and isinstance(resolved.get(name), dict):
            resolved[name] = _merge_object(resolved[name], value, name)
        else:
            resolved[name] = copy.deepcopy(value)
    return resolved
