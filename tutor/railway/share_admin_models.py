#!/usr/bin/env python3
"""Make the admin's deployment model catalog the default model pool for members.

DeepTutor's upstream multi-user layer intentionally requires per-user LLM grants.
Murikah Tutor has a different product policy: administrators configure the
deployment model pool once, and ordinary accounts inherit every shareable model
automatically. Owner-bound/personal OAuth models remain private to their owner.

This overlay also hides deployment model configuration pages from non-admin
users. The backend already rejects catalog writes from ordinary users; the
frontend should communicate the same boundary instead of presenting dead
configuration pages.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_model_access(root: Path) -> None:
    path = root / "deeptutor/multi_user/model_access.py"

    is_owner_bound_block = '''def is_owner_bound(profile: dict[str, Any]) -> bool:
    """Whether a profile is tied to the identity of the operator who set it up.

    OAuth providers such as Codex authenticate one individual's plan rather than
    a billable team key, so those profiles are never lent to other accounts
    through grants — each user signs in for themselves or goes without.
    """
    binding = str(profile.get("binding") or "").strip().lower()
    if binding in OWNER_BOUND_BINDINGS:
        return True
    return bool(profile.get("owner_bound"))


'''
    deployment_helper = is_owner_bound_block + '''def deployment_llm_rows(
    catalog: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return every admin-configured LLM that is safe to share with members.

    Murikah treats the administrator's model catalog as deployment policy, not
    as a list that must be copied into every new account. That means new and
    existing members immediately inherit additions/removals made by the admin.

    Owner-bound providers are deliberately excluded: an admin's personal Codex
    or similar OAuth session must never become another learner's credential.
    """
    catalog = catalog or admin_catalog()
    rows: list[dict[str, Any]] = []
    for profile in catalog.get("services", {}).get("llm", {}).get("profiles", []) or []:
        if not isinstance(profile, dict) or is_owner_bound(profile):
            continue
        profile_id = str(profile.get("id") or "").strip()
        if not profile_id:
            continue
        for model in profile.get("models", []) or []:
            if not isinstance(model, dict):
                continue
            model_id = str(model.get("id") or "").strip()
            if not model_id:
                continue
            try:
                effective = resolve_profile_provider(catalog, "llm", profile, model)
            except ValueError:
                continue
            if is_owner_bound(effective):
                continue
            rows.append(
                {
                    "profile_id": profile_id,
                    "model_id": model_id,
                    "name": model.get("name") or model.get("model") or model_id,
                    "model": model.get("model") or "",
                    "provider": effective.get("binding") or "",
                    "profile_name": effective.get("name") or profile.get("name") or profile_id,
                    "reasoning_effort": model.get("reasoning_effort"),
                    "supported_reasoning_efforts": model.get(
                        "codex_supported_reasoning_levels"
                    ),
                    "source": "admin",
                    "available": True,
                }
            )
    return rows


'''
    replace_once(
        path,
        is_owner_bound_block,
        deployment_helper,
        "owner-bound model helper",
    )

    old_result = '''    grant = load_grant(user_id)
    catalog = admin_catalog()
    result: dict[str, list[dict[str, Any]]] = {"llm": []}
    for item in grant.get("models", {}).get("llm", []) or []:
'''
    new_result = '''    grant = load_grant(user_id)
    catalog = admin_catalog()
    inherited = deployment_llm_rows(catalog)
    result: dict[str, list[dict[str, Any]]] = {"llm": list(inherited)}
    inherited_keys = {
        (str(item.get("profile_id") or ""), str(item.get("model_id") or ""))
        for item in inherited
    }
    for item in grant.get("models", {}).get("llm", []) or []:
'''
    replace_once(path, old_result, new_result, "effective model-access seed")

    old_model_loop = '''        for model_id in item.get("model_ids") or []:
            model = _model_by_id(profile, str(model_id))
            try:
'''
    new_model_loop = '''        for model_id in item.get("model_ids") or []:
            model_id = str(model_id)
            if (profile_id, model_id) in inherited_keys:
                # Legacy/manual grants may contain a model that is now part of
                # Murikah's shared deployment pool. Keep the effective option
                # list unique rather than rendering the same model twice.
                continue
            model = _model_by_id(profile, model_id)
            try:
'''
    replace_once(path, old_model_loop, new_model_loop, "grant model loop")

    old_model_id = '''                    "model_id": str(model_id),
'''
    new_model_id = '''                    "model_id": model_id,
'''
    replace_once(path, old_model_id, new_model_id, "normalized grant model id")

    old_active = '''    active = next(
        (
            {"profile_id": active_profile_id, "model_id": active_model_id}
            for option in options
            if option["is_active_default"]
        ),
        None,
    )
    return {"active": active, "options": options}
'''
    new_active = '''    active = next(
        (
            {"profile_id": active_profile_id, "model_id": active_model_id}
            for option in options
            if option["is_active_default"]
        ),
        None,
    )
    # If the admin's active profile is owner-bound/private, members still need
    # a usable deployment default. Fall back to the first shareable configured
    # model without exposing the private provider.
    if active is None and options:
        active = {
            "profile_id": str(options[0]["profile_id"]),
            "model_id": str(options[0]["model_id"]),
        }
    return {"active": active, "options": options}
'''
    replace_once(path, old_active, new_active, "member active-model fallback")


def patch_settings_navigation(root: Path) -> None:
    path = root / "web/features/settings/navigation/settings-nav.ts"
    text = path.read_text(encoding="utf-8")
    start = text.find("const MODEL_CHILDREN: SettingsLeaf[] = [")
    end = text.find("const CHAT_CHILDREN: SettingsLeaf[] = [", start)
    if start < 0 or end < 0:
        raise RuntimeError(f"Could not locate MODEL_CHILDREN in {path}")
    before, model_block, after = text[:start], text[start:end], text[end:]

    keys = (
        "voice",
        "multimodal",
        "connections",
        "llm",
        "task-models",
        "embedding",
        "search",
        "tts",
        "stt",
        "imagegen",
        "videogen",
    )
    for key in keys:
        pattern = rf'(\n\s*key: "{re.escape(key)}",\n)'
        match = re.search(pattern, model_block)
        if match is None:
            raise RuntimeError(f"Missing model settings leaf {key!r} in {path}")
        item_start = match.start()
        next_item = model_block.find("\n  {", match.end())
        item_end = len(model_block) if next_item < 0 else next_item
        item = model_block[item_start:item_end]
        if "adminOnly: true" in item:
            continue
        replacement = match.group(1) + "    adminOnly: true,\n"
        model_block = (
            model_block[:match.start()]
            + re.sub(pattern, replacement, model_block[match.start():], count=1)
        )

    path.write_text(before + model_block + after, encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: share_admin_models.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    patch_model_access(root)
    patch_settings_navigation(root)
    print(
        "[Murikah Tutor] Members now inherit all shareable admin LLMs; "
        "deployment model configuration is admin-only."
    )


if __name__ == "__main__":
    main()
