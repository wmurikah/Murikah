#!/usr/bin/env python3
"""Add bounded configured-model fallback to the Murikah guest completion path."""
from __future__ import annotations

from pathlib import Path
import sys


MARKER = "Guest completion fallback exhausted"

OLD = '''    client = _client_for_selection(body.llm_selection)
    incident_id = uuid.uuid4().hex[:10]
    max_tokens = 1800 if body.space == "diagram" else 1100
    try:
        answer = await asyncio.wait_for(
            client.complete(
                _prompt_with_attachments(prompt, body.attachments),
                system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),
                history=history,
                max_tokens=max_tokens,
            ),
            timeout=_GUEST_COMPLETION_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        logger.warning("Guest completion timed out [%s]", incident_id)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Tutor took too long to respond. Please try again. Reference {incident_id}.",
        ) from exc
    except Exception as exc:
        logger.exception("Guest completion failed [%s] (%s)", incident_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Tutor is temporarily unavailable. Please try again. Reference {incident_id}.",
        ) from exc

    next_used = used + 1
'''

NEW = '''    incident_id = uuid.uuid4().hex[:10]
    max_tokens = 1800 if body.space == "diagram" else 1100

    # Keep the learner's explicit choice first. Otherwise start with the catalog
    # default, then use the remaining already-configured models as bounded
    # availability fallbacks. No provider credentials or model settings are
    # changed here; selections are resolved from the existing server catalog.
    requested_selection = _selection_payload(body.llm_selection)
    catalog_options = list_llm_options(get_model_catalog_service().load())
    candidates: list[dict[str, str]] = []

    def add_candidate(value: Any) -> None:
        if not isinstance(value, dict):
            return
        profile_id = str(value.get("profile_id") or "").strip()
        model_id = str(value.get("model_id") or "").strip()
        if not profile_id or not model_id:
            return
        candidate = {"profile_id": profile_id, "model_id": model_id}
        reasoning_effort = str(value.get("reasoning_effort") or "").strip().lower()
        if reasoning_effort:
            candidate["reasoning_effort"] = reasoning_effort
        if not any(
            item.get("profile_id") == profile_id and item.get("model_id") == model_id
            for item in candidates
        ):
            candidates.append(candidate)

    add_candidate(requested_selection)
    add_candidate(catalog_options.get("active"))
    for item in catalog_options.get("options", []) or []:
        add_candidate(item)

    # Three configured models are expected in Cloudflare. Keep the entire guest
    # request inside the existing ~75 second resilience envelope rather than
    # waiting 75 seconds on one provider/model.
    attempt_budgets = (32, 20, 16)
    answer: Any | None = None
    saw_provider_error = False
    for attempt, candidate in enumerate(candidates[: len(attempt_budgets)]):
        model_id = candidate.get("model_id", "unknown")
        try:
            client = LLMClient(
                config=resolve_llm_config_for_selection(candidate),
                configure_env=False,
            )
            answer = await asyncio.wait_for(
                client.complete(
                    _prompt_with_attachments(prompt, body.attachments),
                    system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),
                    history=history,
                    max_tokens=max_tokens,
                ),
                timeout=attempt_budgets[attempt],
            )
            logger.info(
                "Guest completion succeeded [%s] model=%s attempt=%s",
                incident_id,
                model_id,
                attempt + 1,
            )
            break
        except asyncio.TimeoutError:
            logger.warning(
                "Guest completion timed out [%s] model=%s attempt=%s",
                incident_id,
                model_id,
                attempt + 1,
            )
        except Exception as exc:
            saw_provider_error = True
            logger.warning(
                "Guest completion provider error [%s] model=%s attempt=%s type=%s",
                incident_id,
                model_id,
                attempt + 1,
                type(exc).__name__,
            )

    if answer is None:
        logger.error(
            "Guest completion fallback exhausted [%s] attempts=%s",
            incident_id,
            min(len(candidates), len(attempt_budgets)),
        )
        if saw_provider_error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Tutor is temporarily unavailable. Please try again. Reference {incident_id}.",
            )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Tutor took too long to respond. Please try again. Reference {incident_id}.",
        )

    next_used = used + 1
'''


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: harden_guest_completion.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    target = root / "deeptutor" / "api" / "routers" / "murikah_guest.py"
    text = target.read_text(encoding="utf-8")
    if MARKER in text:
        print("[Murikah Tutor] Guest completion fallback already applied.")
        return 0
    count = text.count(OLD)
    if count != 1:
        print(
            f"Expected exactly one resilient guest completion block, found {count}",
            file=sys.stderr,
        )
        return 1
    target.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("[Murikah Tutor] Added bounded guest model fallback.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
