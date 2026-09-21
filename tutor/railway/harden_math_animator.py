#!/usr/bin/env python3
"""Harden the pinned DeepTutor Math Animator structured-output pipeline.

MURIKAH_MATH_ANIMATOR_STRUCTURED_V1

The upstream v1.6.6 Math Animator expects several LLM stages to return JSON.
Concept analysis, scene design and summary parse once and let JSONDecodeError
escape. Code generation retries the same provider, but has no independent
provider recovery. Murikah runs the lightweight structured stages through the
already-configured direct Gemini/NVIDIA/Qwen providers with strict validation,
bounded deadlines and deterministic pedagogical fallbacks. Code generation
keeps its existing primary model/retries and gains the same independent
structured fallback before failing.

No chat/follow-up/stream-continuation routing is changed by this overlay.
"""
from __future__ import annotations

from pathlib import Path
import sys


STRUCTURED_OUTPUT = r'''"""Reliable structured-output helpers for Murikah Math Animator."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from typing import Any, Awaitable, Callable, TypeVar

from pydantic import BaseModel

from deeptutor.murikah_fast_lane import (
    close_stream,
    configured_gemini_model,
    configured_nvidia_fast_model,
    configured_qwen_fast_model,
    finish_reason_needs_continuation,
    gemini_configured,
    gemini_stream,
    nvidia_configured,
    nvidia_stream,
    parse_finish_signal,
    qwen_configured,
    qwen_stream,
)
from .utils import extract_json_object

logger = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

DIRECT_TIMEOUT_SECONDS = max(
    8.0, float(os.environ.get("MURIKAH_MATH_STRUCTURED_TIMEOUT_SECONDS", "24") or 24)
)
PRIMARY_TIMEOUT_SECONDS = max(
    8.0, float(os.environ.get("MURIKAH_MATH_PRIMARY_TIMEOUT_SECONDS", "24") or 24)
)


def _json_instruction(schema_name: str) -> str:
    return (
        "\n\nIMPORTANT OUTPUT CONTRACT: Return exactly one valid JSON object for "
        f"{schema_name}. Do not use Markdown fences. Do not include reasoning, "
        "preamble, commentary, or text after the JSON object."
    )


async def _collect_direct(
    *,
    name: str,
    factory: Callable[[], Any],
    model_cls: type[T],
    required_nonempty: str = "",
) -> T:
    stream = factory()
    parts: list[str] = []
    in_think = False
    finish_reason = ""
    try:
        async with asyncio.timeout(DIRECT_TIMEOUT_SECONDS):
            async for chunk in stream:
                text = str(chunk or "")
                reason = parse_finish_signal(text)
                if reason is not None:
                    finish_reason = reason
                    continue
                if text == "<think>":
                    in_think = True
                    continue
                if text == "</think>":
                    in_think = False
                    continue
                if not in_think and text:
                    parts.append(text)
    finally:
        await close_stream(stream)

    raw = "".join(parts).strip()
    if not raw:
        raise ValueError(f"{name} returned no visible structured content")
    if finish_reason_needs_continuation(finish_reason):
        raise ValueError(f"{name} exhausted its structured-output budget")

    value = model_cls.model_validate(extract_json_object(raw))
    if required_nonempty and not str(getattr(value, required_nonempty, "") or "").strip():
        raise ValueError(f"{name} returned an empty {required_nonempty} field")
    return value


async def direct_structured_payload(
    *,
    model_cls: type[T],
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 1800,
    required_nonempty: str = "",
) -> T | None:
    """Return the first fully valid object from independent direct providers."""
    messages = [
        {
            "role": "system",
            "content": system_prompt + _json_instruction(model_cls.__name__),
        },
        {
            "role": "user",
            "content": user_prompt + _json_instruction(model_cls.__name__),
        },
    ]
    candidates: list[tuple[str, Callable[[], Any]]] = []
    if gemini_configured():
        candidates.append(
            (
                f"gemini:{configured_gemini_model()}",
                lambda: gemini_stream(messages, max_tokens=max_tokens),
            )
        )
    if qwen_configured():
        candidates.append(
            (
                f"qwen:{configured_qwen_fast_model()}",
                lambda: qwen_stream(messages, max_tokens=max_tokens),
            )
        )
    if nvidia_configured():
        candidates.append(
            (
                f"nvidia:{configured_nvidia_fast_model()}",
                lambda: nvidia_stream(messages, max_tokens=max_tokens),
            )
        )
    if not candidates:
        return None

    tasks = {
        asyncio.create_task(
            _collect_direct(
                name=name,
                factory=factory,
                model_cls=model_cls,
                required_nonempty=required_nonempty,
            )
        ): name
        for name, factory in candidates
    }
    try:
        async with asyncio.timeout(DIRECT_TIMEOUT_SECONDS + 2.0):
            for completed in asyncio.as_completed(tasks):
                try:
                    result = await completed
                except Exception as exc:
                    logger.warning(
                        "Math Animator structured provider failed: %s",
                        type(exc).__name__,
                    )
                    continue
                for task in tasks:
                    if not task.done():
                        task.cancel()
                return result
    except asyncio.TimeoutError:
        logger.warning("Math Animator direct structured provider race timed out")
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    return None


async def request_structured_payload(
    *,
    agent: Any,
    model_cls: type[T],
    user_prompt: str,
    system_prompt: str,
    stage: str,
    trace_meta: dict[str, Any],
    fallback: Callable[[], T],
    messages: list[dict[str, Any]] | None = None,
    attachments: list[Any] | None = None,
    max_tokens: int = 1800,
    required_nonempty: str = "",
) -> T:
    """Bounded, validated structured generation with a safe final fallback.

    Text-only orchestration stages prefer Murikah's direct provider pool. This
    avoids a slow reasoning model spending minutes on a small JSON planning
    object. Multimodal analysis stays on BaseAgent so image attachments retain
    vision support.
    """
    if not attachments:
        direct = await direct_structured_payload(
            model_cls=model_cls,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
            required_nonempty=required_nonempty,
        )
        if direct is not None:
            return direct

    repair = _json_instruction(model_cls.__name__)
    for attempt in range(2):
        prompt = user_prompt + (repair if attempt else "")
        try:
            response = await asyncio.wait_for(
                agent.call_llm(
                    user_prompt=prompt,
                    system_prompt=system_prompt,
                    messages=messages if attempt == 0 else None,
                    attachments=attachments,
                    response_format={"type": "json_object"},
                    temperature=0.1,
                    max_tokens=max_tokens,
                    stage=stage,
                    trace_meta={**trace_meta, "structured_attempt": attempt + 1},
                    verbose=False,
                ),
                timeout=PRIMARY_TIMEOUT_SECONDS,
            )
            value = model_cls.model_validate(extract_json_object(response))
            if required_nonempty and not str(
                getattr(value, required_nonempty, "") or ""
            ).strip():
                raise ValueError(f"empty {required_nonempty} field")
            return value
        except Exception as exc:
            logger.warning(
                "Math Animator %s structured attempt %s failed: %s",
                stage,
                attempt + 1,
                type(exc).__name__,
            )

    logger.warning(
        "Math Animator %s is using deterministic structured fallback",
        stage,
    )
    return fallback()


__all__ = [
    "direct_structured_payload",
    "request_structured_payload",
]
'''


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_analysis(root: Path) -> None:
    path = root / "deeptutor/agents/math_animator/agents/concept_analysis_agent.py"
    replace_once(
        path,
        "from ..utils import extract_json_object\n",
        "from ..structured_output import request_structured_payload\n",
        "analysis structured import",
    )
    old = '''        _chunks: list[str] = []
        async for _c in self.stream_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            messages=messages,
            attachments=attachments,
            response_format={"type": "json_object"},
            stage="concept_analysis",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-analysis"),
                phase="concept_analysis",
                label="Concept analysis",
                call_kind="math_concept_analysis",
                trace_role="analyze",
                trace_kind="llm_output",
            ),
        ):
            _chunks.append(_c)
        response = "".join(_chunks)
        return ConceptAnalysis.model_validate(extract_json_object(response))
'''
    new = '''        return await request_structured_payload(
            agent=self,
            model_cls=ConceptAnalysis,
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            messages=messages,
            attachments=attachments,
            max_tokens=min(1800, self.get_max_tokens()),
            stage="concept_analysis",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-analysis"),
                phase="concept_analysis",
                label="Concept analysis",
                call_kind="math_concept_analysis",
                trace_role="analyze",
                trace_kind="llm_output",
            ),
            fallback=lambda: ConceptAnalysis(
                learning_goal=f"Explain visually: {user_input.strip()[:500]}",
                math_focus=[user_input.strip()[:300]],
                visual_targets=[
                    "Use clear mathematical labels and a visual representation of the quantities or relationships."
                ],
                narrative_steps=[
                    "State the problem clearly.",
                    "Build the visual representation.",
                    "Work through the reasoning step by step.",
                    "Highlight the final result.",
                ],
                reference_usage=(
                    "Use the supplied reference image only as contextual guidance."
                    if attachments
                    else "No external reference is required."
                ),
                output_intent=f"Create a clear {output_mode} mathematical explanation.",
            ),
        )
'''
    replace_once(path, old, new, "concept analysis one-shot JSON parse")


def patch_design(root: Path) -> None:
    path = root / "deeptutor/agents/math_animator/agents/concept_design_agent.py"
    replace_once(
        path,
        "from ..utils import extract_json_object\n",
        "from ..structured_output import request_structured_payload\n",
        "design structured import",
    )
    old = '''        _chunks: list[str] = []
        async for _c in self.stream_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            response_format={"type": "json_object"},
            stage="concept_design",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-design"),
                phase="concept_design",
                label="Concept design",
                call_kind="math_concept_design",
                trace_role="design",
                trace_kind="llm_output",
            ),
        ):
            _chunks.append(_c)
        response = "".join(_chunks)
        return SceneDesign.model_validate(extract_json_object(response))
'''
    new = '''        return await request_structured_payload(
            agent=self,
            model_cls=SceneDesign,
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            max_tokens=min(1800, self.get_max_tokens()),
            stage="concept_design",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-design"),
                phase="concept_design",
                label="Concept design",
                call_kind="math_concept_design",
                trace_role="design",
                trace_kind="llm_output",
            ),
            fallback=lambda: SceneDesign(
                title="Math explanation",
                scene_outline=[
                    "Introduce the problem and known values.",
                    "Build the main mathematical visual.",
                    "Animate the solution steps in order.",
                    "Emphasize the final answer.",
                ],
                visual_style=style_hint.strip()
                or "Clean classroom-style animation with high-contrast labels and uncluttered diagrams.",
                animation_notes=[
                    "Keep mathematical labels legible.",
                    "Use simple transitions and avoid decorative motion.",
                    "Keep the final result visible long enough to read.",
                ],
                image_plan=[],
                code_constraints=[
                    "Use Manim Community Edition APIs only.",
                    "Use three-dimensional coordinate points where Manim expects point arrays.",
                    "Do not require network access or external assets.",
                ],
            ),
        )
'''
    replace_once(path, old, new, "concept design one-shot JSON parse")


def patch_summary(root: Path) -> None:
    path = root / "deeptutor/agents/math_animator/agents/summary_agent.py"
    replace_once(
        path,
        "from ..utils import extract_json_object\n",
        "from ..structured_output import request_structured_payload\n",
        "summary structured import",
    )
    old = '''        _chunks: list[str] = []
        async for _c in self.stream_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            response_format={"type": "json_object"},
            stage="summary",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-summary"),
                phase="summary",
                label="Summarize result",
                call_kind="math_summary",
                trace_role="summarize",
                trace_kind="llm_output",
            ),
        ):
            _chunks.append(_c)
        response = "".join(_chunks)
        return SummaryPayload.model_validate(extract_json_object(response))
'''
    new = '''        return await request_structured_payload(
            agent=self,
            model_cls=SummaryPayload,
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            max_tokens=min(1200, self.get_max_tokens()),
            stage="summary",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-summary"),
                phase="summary",
                label="Summarize result",
                call_kind="math_summary",
                trace_role="summarize",
                trace_kind="llm_output",
            ),
            fallback=lambda: SummaryPayload(
                summary_text="Your math animation is ready.",
                user_request=user_input.strip(),
                generated_output=(
                    f"Generated {len(render_result.artifacts)} "
                    f"{output_mode} artifact{'s' if len(render_result.artifacts) != 1 else ''}."
                ),
                key_points=list(analysis.narrative_steps[:4]),
            ),
        )
'''
    replace_once(path, old, new, "summary one-shot JSON parse")


def patch_code_generator(root: Path) -> None:
    path = root / "deeptutor/agents/math_animator/agents/code_generator_agent.py"
    replace_once(
        path,
        "from ..models import ConceptAnalysis, GeneratedCode, SceneDesign\n",
        "from ..models import ConceptAnalysis, GeneratedCode, SceneDesign\n"
        "from ..structured_output import direct_structured_payload\n",
        "code fallback import",
    )
    old = '''        attempts = max_retries + 1
        raise GeneratedCodeOutputError(
            f"Math animator {stage} returned no usable code after {attempts} attempts."
        ) from last_error
'''
    new = '''        # The configured deep model remains primary. If it repeatedly returns
        # blank/malformed JSON, use Murikah's independent provider pool once
        # before failing the learner's animation.
        fallback = await direct_structured_payload(
            model_cls=GeneratedCode,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max(3200, self.get_max_tokens()),
            required_nonempty="code",
        )
        if fallback is not None:
            return fallback

        attempts = max_retries + 1
        raise GeneratedCodeOutputError(
            "Murikah could not prepare animation code after bounded retries."
        ) from last_error
'''
    replace_once(path, old, new, "code generator terminal structured failure")


def patch_capability(root: Path) -> None:
    path = root / "deeptutor/agents/math_animator/capability.py"
    old = '''                await stream.error(
                    str(update.get("response", "") or fallback),
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
'''
    new = '''                # Provider/backend details belong in server logs, never in a
                # learner-facing Math Animator bubble.
                await stream.error(
                    fallback,
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
'''
    replace_once(path, old, new, "learner-safe Math Animator trace error")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: harden_math_animator.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    package = root / "deeptutor/agents/math_animator"
    (package / "structured_output.py").write_text(STRUCTURED_OUTPUT, encoding="utf-8")
    patch_analysis(root)
    patch_design(root)
    patch_summary(root)
    patch_code_generator(root)
    patch_capability(root)
    print(
        "[Murikah Tutor] Math Animator structured stages now use bounded "
        "provider recovery and learner-safe fallbacks."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
