#!/usr/bin/env python3
"""Harden Murikah Tutor fast-lane provider failover and error handling."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def patch_fast_lane(root: Path) -> None:
    target = root / "deeptutor" / "murikah_fast_lane.py"
    text = target.read_text(encoding="utf-8")
    if "MURIKAH_FAST_LANE_FAILOVER_V3" in text:
        return

    text = replace_once(
        text,
        'logger = logging.getLogger(__name__)\n',
        'logger = logging.getLogger(__name__)\n\n# MURIKAH_FAST_LANE_FAILOVER_V3\n',
        "fast-lane marker",
    )
    text = replace_once(
        text,
        '    async with httpx.AsyncClient(timeout=timeout) as client:\n',
        '    # Cloudflare provides direct container egress. Ignore inherited proxy\n'
        '    # variables so a stale proxy cannot turn provider calls into generic\n'
        '    # connection failures.\n'
        '    async with httpx.AsyncClient(\n'
        '        timeout=timeout, follow_redirects=True, trust_env=False\n'
        '    ) as client:\n',
        "Gemini HTTP client",
    )
    text = replace_once(
        text,
        '            response.raise_for_status()\n'
        '            logger.info(\n'
        '                "MURIKAH_LATENCY route=fast provider=gemini event=headers model=%s elapsed_ms=%s",\n'
        '                model,\n'
        '                latency_ms(request_started),\n'
        '            )\n',
        '            if response.status_code >= 400:\n'
        '                logger.warning(\n'
        '                    "MURIKAH_LATENCY route=fast provider=gemini event=http_error "\n'
        '                    "model=%s status=%s elapsed_ms=%s",\n'
        '                    model,\n'
        '                    response.status_code,\n'
        '                    latency_ms(request_started),\n'
        '                )\n'
        '            response.raise_for_status()\n'
        '            logger.info(\n'
        '                "MURIKAH_LATENCY route=fast provider=gemini event=headers model=%s elapsed_ms=%s",\n'
        '                model,\n'
        '                latency_ms(request_started),\n'
        '            )\n',
        "Gemini status diagnostics",
    )
    text = replace_once(
        text,
        '        if in_think or not text:\n'
        '            continue\n'
        '        return text\n'
        '    raise StopAsyncIteration\n',
        '        if in_think or not text:\n'
        '            continue\n'
        '        normalized = text.strip().lower()\n'
        '        if normalized.startswith("error calling llm:") or normalized.startswith("llm call failed:"):\n'
        '            raise RuntimeError("Provider returned an error payload instead of model output")\n'
        '        return text\n'
        '    raise StopAsyncIteration\n',
        "provider error-token guard",
    )
    target.write_text(text, encoding="utf-8")


def patch_authenticated_chat(root: Path) -> None:
    target = root / "deeptutor" / "agents" / "chat" / "capability.py"
    text = target.read_text(encoding="utf-8")
    if "gemini_compat =" in text:
        return

    old = '''        non_gemini = [config for config in resolved if str(config.model) != gemini_model]\n        if resolved and not selected_is_gemini:\n            hedges.append(deep_candidate(resolved[0], 0.0))\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini:{gemini_model}",\n                        delay_seconds=2.5,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            remainder = [config for config in non_gemini if config is not resolved[0]]\n            for index, config in enumerate(remainder[:2]):\n                hedges.append(deep_candidate(config, 4.5 + (index * 2.0)))\n        else:\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini:{gemini_model}",\n                        delay_seconds=0.0,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            for index, config in enumerate(non_gemini[:3]):\n                delay = 2.5 + (index * 2.0) if gemini_on else index * 2.5\n                hedges.append(deep_candidate(config, delay))\n'''
    new = '''        gemini_compat = [config for config in resolved if str(config.model) == gemini_model]\n        non_gemini = [config for config in resolved if str(config.model) != gemini_model]\n        if resolved and not selected_is_gemini:\n            hedges.append(deep_candidate(resolved[0], 0.0))\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini-native:{gemini_model}",\n                        delay_seconds=2.5,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            if gemini_compat:\n                hedges.append(deep_candidate(gemini_compat[0], 3.5))\n            remainder = [config for config in non_gemini if config is not resolved[0]]\n            for index, config in enumerate(remainder[:2]):\n                hedges.append(deep_candidate(config, 4.5 + (index * 2.0)))\n        else:\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini-native:{gemini_model}",\n                        delay_seconds=0.0,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            # Use DeepTutor's supported Gemini OpenAI-compatible transport as an\n            # independent hedge before NVIDIA. The first real model token wins.\n            if gemini_compat:\n                hedges.append(deep_candidate(gemini_compat[0], 1.0))\n            for index, config in enumerate(non_gemini[:3]):\n                delay = 2.5 + (index * 2.0) if gemini_on else index * 2.5\n                hedges.append(deep_candidate(config, delay))\n'''
    text = replace_once(text, old, new, "authenticated hedge block")
    target.write_text(text, encoding="utf-8")


def patch_guest_chat(root: Path) -> None:
    target = root / "deeptutor" / "api" / "routers" / "murikah_guest.py"
    text = target.read_text(encoding="utf-8")
    marker = "Provider returned an error payload instead of guest output"
    if marker in text:
        return
    old = '''            if in_think or not text:\n                continue\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n'''
    new = '''            if in_think or not text:\n                continue\n            normalized = text.strip().lower()\n            if normalized.startswith("error calling llm:") or normalized.startswith("llm call failed:"):\n                raise RuntimeError("Provider returned an error payload instead of guest output")\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n'''
    text = replace_once(text, old, new, "guest error-token guard")
    target.write_text(text, encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: harden_fast_lane_failover.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    try:
        patch_fast_lane(root)
        patch_authenticated_chat(root)
        patch_guest_chat(root)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("[Murikah Tutor] Hardened fast-lane transport and provider failover.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
