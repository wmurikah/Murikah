#!/usr/bin/env python3
"""Add the optional Gemini fast-chat profile without changing deep-task providers."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from typing import Any

CATALOG = Path("/app/data/user/settings/model_catalog.json")
PROFILE_ID = "muri-llm-gemini"
MODEL_ID = "muri-llm-gemini-fast"
DEFAULT_MODEL = "gemini-3.8-flash"
GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> None:
    runtime = os.environ.get("MURIKAH_TUTOR_RUNTIME", "").strip()
    if not runtime.startswith("cloudflare-container"):
        return

    api_key = os.environ.get("MURIKAH_GEMINI_API_KEY", "").strip()
    if not api_key:
        print("[Murikah Tutor] Gemini fast lane is not configured; existing LLM catalog preserved.")
        return

    model = os.environ.get("MURIKAH_FAST_CHAT_MODEL", "").strip() or DEFAULT_MODEL
    if not CATALOG.exists():
        raise RuntimeError("Cloudflare model catalog is missing before fast-lane bootstrap.")

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    services = catalog.setdefault("services", {})
    llm = services.get("llm")
    if not isinstance(llm, dict):
        raise RuntimeError("Cloudflare model catalog has no LLM service.")

    profiles = [
        item
        for item in (llm.get("profiles") or [])
        if isinstance(item, dict) and item.get("id") != PROFILE_ID
    ]
    gemini_profile = {
        "id": PROFILE_ID,
        "name": "Google Gemini Fast Chat",
        "binding": "gemini",
        "api_key": api_key,
        "base_url": GEMINI_OPENAI_BASE,
        "api_version": "",
        "extra_headers": {},
        # Google's compatibility endpoint explicitly supports Chat Completions.
        # Do not let provider auto-selection choose a different wire protocol.
        "api_format": "openai_chat",
        "wire_api": "auto",
        "models": [
            {
                "id": MODEL_ID,
                "name": model,
                "model": model,
                "reasoning_effort": "low",
            }
        ],
    }
    llm["profiles"] = [gemini_profile, *profiles]
    llm["active_profile_id"] = PROFILE_ID
    llm["active_model_id"] = MODEL_ID
    atomic_write(CATALOG, catalog)
    print(f"[Murikah Tutor] Gemini fast lane enabled with model {model}.")


if __name__ == "__main__":
    main()
