"""Provider-neutral Phase 3 model resolution using Murikah's existing catalog and grants."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .roles import RolePolicy


@dataclass(frozen=True)
class ProviderCandidate:
    profile_id: str
    model_id: str
    provider: str
    model: str
    config: Any


def _selection_key(value: Any) -> tuple[str, str] | None:
    if not isinstance(value, dict):
        return None
    profile_id = str(value.get("profile_id") or "").strip()
    model_id = str(value.get("model_id") or "").strip()
    return (profile_id, model_id) if profile_id and model_id else None


def resolve_role_candidates(
    policy: RolePolicy,
    *,
    requested_selection: dict[str, Any] | None = None,
    allowed_options_getter: Callable[[], dict[str, Any]] | None = None,
    config_resolver: Callable[[dict[str, Any]], Any] | None = None,
) -> list[ProviderCandidate]:
    if allowed_options_getter is None:
        from deeptutor.multi_user.model_access import allowed_llm_options
        allowed_options_getter = allowed_llm_options
    if config_resolver is None:
        from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection
        config_resolver = resolve_llm_config_for_selection
    options = allowed_options_getter() or {}
    allowed_rows = [options.get("active"), *(options.get("options") or [])]
    allowed = {_selection_key(row) for row in allowed_rows}
    allowed.discard(None)
    ordered: list[dict[str, Any]] = []

    def add(row: Any) -> None:
        key = _selection_key(row)
        if key is None or key not in allowed:
            return
        if not any(_selection_key(existing) == key for existing in ordered):
            ordered.append(dict(row))

    add(requested_selection)
    add(options.get("active"))
    for row in options.get("options") or []:
        add(row)

    resolved: list[ProviderCandidate] = []
    seen: set[tuple[str, str]] = set()
    for selection in ordered:
        try:
            config = config_resolver(selection)
        except Exception:
            continue
        provider = str(getattr(config, "provider_name", None) or getattr(config, "binding", None) or "").strip()
        model = str(getattr(config, "model", "") or "").strip()
        key = (provider, model)
        if not provider or not model or key in seen:
            continue
        seen.add(key)
        profile_id, model_id = _selection_key(selection) or ("", "")
        resolved.append(ProviderCandidate(profile_id, model_id, provider, model, config))
        if len(resolved) >= policy.candidate_limit:
            break
    return resolved


def provider_stream(candidate: ProviderCandidate, messages: list[dict[str, str]], *, max_tokens: int):
    from deeptutor.services.llm import factory as llm_factory
    config = candidate.config
    return llm_factory.stream(
        prompt="",
        system_prompt="",
        model=config.model,
        api_key=config.api_key,
        base_url=config.effective_url or config.base_url,
        api_version=config.api_version,
        binding=config.provider_name or config.binding,
        messages=messages,
        max_retries=0,
        reasoning_effort=config.reasoning_effort,
        extra_headers=config.extra_headers,
        max_tokens=max_tokens,
        stream_coalesce_chars=24,
        stream_coalesce_seconds=0.02,
    )


__all__ = ["ProviderCandidate", "provider_stream", "resolve_role_candidates"]
