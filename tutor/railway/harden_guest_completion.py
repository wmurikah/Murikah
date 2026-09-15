#!/usr/bin/env python3
"""Make Murikah guest chat stream promptly with bounded first-token failover."""
from __future__ import annotations

from pathlib import Path
import sys

BACKEND_MARKER = "Guest first-token failover exhausted"
FRONTEND_MARKER = "Stream the answer as soon as the provider produces text"

NEW_BACKEND = '''    incident_id = uuid.uuid4().hex[:10]\n    max_tokens = 1800 if body.space == "diagram" else 1100\n\n    # First-token failover, not full-answer timeout. A responsive model starts\n    # rendering immediately; only a model that produces no visible text within\n    # its short window is abandoned for the next already-configured model.\n    requested_selection = _selection_payload(body.llm_selection)\n    catalog_options = list_llm_options(get_model_catalog_service().load())\n    candidates: list[dict[str, str]] = []\n\n    def add_candidate(value: Any) -> None:\n        if not isinstance(value, dict):\n            return\n        profile_id = str(value.get("profile_id") or "").strip()\n        model_id = str(value.get("model_id") or "").strip()\n        if not profile_id or not model_id:\n            return\n        candidate = {"profile_id": profile_id, "model_id": model_id}\n        reasoning_effort = str(value.get("reasoning_effort") or "").strip().lower()\n        if reasoning_effort:\n            candidate["reasoning_effort"] = reasoning_effort\n        if not any(\n            item.get("profile_id") == profile_id and item.get("model_id") == model_id\n            for item in candidates\n        ):\n            candidates.append(candidate)\n\n    add_candidate(requested_selection)\n    add_candidate(catalog_options.get("active"))\n    for item in catalog_options.get("options", []) or []:\n        add_candidate(item)\n\n    messages_for_provider: list[dict[str, str]] = [\n        {\n            "role": "system",\n            "content": _system_prompt(body.mode, body.space, body.configuration, body.persona),\n        },\n        *history,\n        {"role": "user", "content": _prompt_with_attachments(prompt, body.attachments)},\n    ]\n\n    first_token_budgets = (6.0, 4.0, 4.0)\n    chosen_stream: Any | None = None\n    first_chunk = ""\n    chosen_model = ""\n    saw_provider_error = False\n\n    async def first_visible_chunk(stream: Any) -> str:\n        in_think = False\n        async for chunk in stream:\n            text = str(chunk or "")\n            if text == "<think>":\n                in_think = True\n                continue\n            if text == "</think>":\n                in_think = False\n                continue\n            if in_think or not text:\n                continue\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n\n    for attempt, candidate in enumerate(candidates[: len(first_token_budgets)]):\n        model_id = candidate.get("model_id", "unknown")\n        candidate_stream: Any | None = None\n        try:\n            config = resolve_llm_config_for_selection(candidate)\n            candidate_stream = llm_factory.stream(\n                prompt="",\n                system_prompt="",\n                model=config.model,\n                api_key=config.api_key,\n                base_url=config.effective_url or config.base_url,\n                api_version=config.api_version,\n                binding=config.provider_name or config.binding,\n                messages=messages_for_provider,\n                max_retries=0,\n                reasoning_effort=config.reasoning_effort,\n                extra_headers=config.extra_headers,\n                max_tokens=max_tokens,\n                stream_coalesce_chars=24,\n                stream_coalesce_seconds=0.02,\n            )\n            first_chunk = await asyncio.wait_for(\n                first_visible_chunk(candidate_stream),\n                timeout=first_token_budgets[attempt],\n            )\n            chosen_stream = candidate_stream\n            chosen_model = model_id\n            logger.info(\n                "Guest stream started [%s] model=%s attempt=%s",\n                incident_id,\n                model_id,\n                attempt + 1,\n            )\n            break\n        except asyncio.TimeoutError:\n            logger.warning(\n                "Guest first token timed out [%s] model=%s attempt=%s",\n                incident_id,\n                model_id,\n                attempt + 1,\n            )\n            if candidate_stream is not None:\n                try:\n                    await candidate_stream.aclose()\n                except Exception:\n                    pass\n        except Exception as exc:\n            saw_provider_error = True\n            logger.warning(\n                "Guest first token failed [%s] model=%s attempt=%s type=%s",\n                incident_id,\n                model_id,\n                attempt + 1,\n                type(exc).__name__,\n            )\n            if candidate_stream is not None:\n                try:\n                    await candidate_stream.aclose()\n                except Exception:\n                    pass\n\n    if chosen_stream is None or not first_chunk:\n        logger.error(\n            "Guest first-token failover exhausted [%s] attempts=%s",\n            incident_id,\n            min(len(candidates), len(first_token_budgets)),\n        )\n        if saw_provider_error:\n            raise HTTPException(\n                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,\n                detail=f"Tutor is temporarily unavailable. Please try again. Reference {incident_id}.",\n            )\n        raise HTTPException(\n            status_code=status.HTTP_504_GATEWAY_TIMEOUT,\n            detail=f"Tutor took too long to start responding. Please try again. Reference {incident_id}.",\n        )\n\n    async def stream_body():\n        in_think = False\n        yield first_chunk\n        try:\n            async for chunk in chosen_stream:\n                text = str(chunk or "")\n                if text == "<think>":\n                    in_think = True\n                    continue\n                if text == "</think>":\n                    in_think = False\n                    continue\n                if in_think or not text:\n                    continue\n                yield text\n        except Exception as exc:\n            logger.exception(\n                "Guest stream interrupted [%s] model=%s type=%s",\n                incident_id,\n                chosen_model,\n                type(exc).__name__,\n            )\n            raise\n\n    next_used = used + 1\n'''

NEW_RETURN = '''    remaining = max(0, limit - next_used)\n    stream_response = StreamingResponse(\n        stream_body(),\n        media_type="text/plain; charset=utf-8",\n        headers={\n            "cache-control": "no-store",\n            "x-accel-buffering": "no",\n            "x-murikah-guest-used": str(next_used),\n            "x-murikah-guest-remaining": str(remaining),\n            "x-murikah-guest-auth-required": "1" if next_used >= limit else "0",\n        },\n    )\n    _set_count(stream_response, next_used)\n    return stream_response\n'''

NEW_FRONTEND = '''      if (!response.ok) {\n        const data = (await response.json().catch(() => ({}))) as GuestChatResponse;\n        if (response.status === 403) {\n          setRemaining(0);\n          setAuthNeeded(true);\n          return;\n        }\n        throw new Error(\n          typeof data.detail === "string"\n            ? data.detail\n            : "Tutor is temporarily unavailable. Your prompt is still here — please try again.",\n        );\n      }\n\n      // Stream the answer as soon as the provider produces text. Do not wait\n      // for a full completion before the learner sees the first words.\n      const reader = response.body?.getReader();\n      if (!reader) throw new Error("Tutor opened a response but did not provide a stream.");\n      const decoder = new TextDecoder();\n      let answer = "";\n      setMessages((current) => [...current, { role: "assistant", content: "" }]);\n\n      while (true) {\n        const { value, done } = await reader.read();\n        if (done) break;\n        const text = decoder.decode(value, { stream: true });\n        if (!text) continue;\n        answer += text;\n        const visibleAnswer = answer;\n        setMessages((current) => {\n          const next = [...current];\n          const index = next.length - 1;\n          if (index >= 0 && next[index]?.role === "assistant") {\n            next[index] = { ...next[index], content: visibleAnswer };\n          }\n          return next;\n        });\n      }\n      const tail = decoder.decode();\n      if (tail) {\n        answer += tail;\n        const visibleAnswer = answer;\n        setMessages((current) => {\n          const next = [...current];\n          const index = next.length - 1;\n          if (index >= 0 && next[index]?.role === "assistant") {\n            next[index] = { ...next[index], content: visibleAnswer };\n          }\n          return next;\n        });\n      }\n      if (!answer.trim()) throw new Error("Tutor did not return an answer. Please try again.");\n\n      setAttachments([]);\n      const headerRemaining = Number(response.headers.get("x-murikah-guest-remaining"));\n      const nextRemaining = Number.isFinite(headerRemaining)\n        ? Math.max(0, headerRemaining)\n        : Math.max(0, remaining - 1);\n      setRemaining(nextRemaining);\n      setAuthNeeded(\n        response.headers.get("x-murikah-guest-auth-required") === "1" || nextRemaining === 0,\n      );\n'''


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, new: str, label: str) -> str:
    start_at = text.find(start)
    if start_at < 0:
        raise RuntimeError(f"Could not find start of {label}")
    end_at = text.find(end, start_at)
    if end_at < 0:
        raise RuntimeError(f"Could not find end of {label}")
    end_at += len(end)
    return text[:start_at] + new + text[end_at:]


def patch_backend(root: Path) -> None:
    target = root / "deeptutor" / "api" / "routers" / "murikah_guest.py"
    text = target.read_text(encoding="utf-8")
    if BACKEND_MARKER in text:
        return
    text = replace_exact(
        text,
        "from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status\n",
        "from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status\nfrom fastapi.responses import StreamingResponse\n",
        "FastAPI import",
    )
    text = replace_exact(
        text,
        "from deeptutor.services.llm.client import LLMClient\n",
        "from deeptutor.services.llm import factory as llm_factory\nfrom deeptutor.services.llm.client import LLMClient\n",
        "LLM factory import",
    )
    text = replace_exact(text, ") -> dict:\n    used = _read_count(mt_guest)\n", ") -> Response:\n    used = _read_count(mt_guest)\n", "guest return annotation")
    text = replace_between(
        text,
        "    client = _client_for_selection(body.llm_selection)\n    incident_id = uuid.uuid4().hex[:10]\n",
        "    next_used = used + 1\n",
        NEW_BACKEND,
        "post-diagram guest completion",
    )
    text = replace_between(
        text,
        "    _set_count(response, next_used)\n",
        "    }\n\n\nasync def _resolve_handoff_token",
        NEW_RETURN + "\n\nasync def _resolve_handoff_token",
        "guest response return",
    )
    target.write_text(text, encoding="utf-8")


def patch_frontend(root: Path) -> None:
    target = root / "web" / "components" / "chat" / "MurikahGuestChat.tsx"
    text = target.read_text(encoding="utf-8")
    if FRONTEND_MARKER in text:
        return
    text = replace_between(
        text,
        "      const data = (await response.json().catch(() => ({}))) as GuestChatResponse;\n",
        "      setAuthNeeded(Boolean(data.requires_auth) || nextRemaining === 0);\n",
        NEW_FRONTEND,
        "guest response handling",
    )
    target.write_text(text, encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: harden_guest_completion.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    try:
        patch_backend(root)
        patch_frontend(root)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("[Murikah Tutor] Added streaming guest chat with fast first-token failover.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
