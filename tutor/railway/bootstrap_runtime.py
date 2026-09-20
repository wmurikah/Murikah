#!/usr/bin/env python3
"""Production hardening and runtime bootstrap for Murikah Tutor.

This wrapper writes only DeepTutor's own runtime settings under ``/app/data``.
It never touches Murikah's Astro, Cloudflare Worker, or Turso stack.

On the Cloudflare Container runtime, model/service configuration is rebuilt from
Worker Variables & Secrets on every container start. Container-local ``/app/data``
can therefore be disposable without losing provider credentials or production
model selections. User content, chats, memory, knowledge bases, and uploads are
still a separate persistence concern.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from typing import Any

DATA_ROOT = Path("/app/data")
SETTINGS_DIR = DATA_ROOT / "user" / "settings"
AUTH_PATH = SETTINGS_DIR / "auth.json"
SYSTEM_PATH = SETTINGS_DIR / "system.json"
MODEL_CATALOG_PATH = SETTINGS_DIR / "model_catalog.json"
VIDEO_LEARNING_PATH = SETTINGS_DIR / "video_learning.json"


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required for the Cloudflare Tutor runtime.")
    return value


def optional_env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def model_name(model_id: str) -> str:
    return model_id.rsplit("/", 1)[-1]


def model_entry(model_id: str, model_key: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": model_key,
        "name": model_name(model_id),
        "model": model_id,
        **extra,
    }


def service_shell(
    profile_id: str,
    active_model_id: str,
    profile: dict[str, Any],
) -> dict[str, Any]:
    return {
        "active_profile_id": profile_id,
        "active_model_id": active_model_id,
        "profiles": [profile],
    }


def _member_session_hours() -> int:
    """Long-lived member session, renewed while the learner uses Tutor.

    Chromium-family browsers cap persistent cookies at roughly 400 days, so
    9,600 hours is both durable and standards-compatible. The auth-status
    overlay refreshes this cookie on normal signed-in use; explicit logout or
    an administrator disabling/revoking the account still wins immediately.
    """
    try:
        value = int(os.environ.get("MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS", "9600"))
    except ValueError as exc:
        raise RuntimeError("MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS must be an integer.") from exc
    # Production policy is deliberately fixed at the browser-compatible
    # persistent-cookie ceiling. A stale dashboard value such as 24h must not
    # silently reintroduce routine member sign-outs.
    return 9600


def bootstrap_auth() -> None:
    expire_hours = _member_session_hours()
    if AUTH_PATH.exists():
        current = json.loads(AUTH_PATH.read_text(encoding="utf-8"))
        if not bool(current.get("enabled")):
            raise RuntimeError(
                "Existing /app/data/user/settings/auth.json has authentication disabled. "
                "Refusing to start an Internet-facing Murikah Tutor deployment."
            )
        changed = False
        if not bool(current.get("cookie_secure")):
            current["cookie_secure"] = True
            changed = True
        # Do not preserve an old 24h/7d setting forever. Production members
        # receive the same long-lived session policy after every container
        # replacement, including accounts created before this deployment.
        if int(current.get("token_expire_hours") or 0) != expire_hours:
            current["token_expire_hours"] = expire_hours
            changed = True
        if changed:
            atomic_write_json(AUTH_PATH, current)
            print(
                "[Murikah Tutor] Enforced secure sliding member session settings "
                f"({expire_hours} hours)."
            )
        else:
            print("[Murikah Tutor] Persistent authentication settings already current.")
        return

    username = os.environ.get("MURIKAH_TUTOR_ADMIN_USERNAME", "admin").strip() or "admin"
    password = os.environ.get("MURIKAH_TUTOR_ADMIN_PASSWORD", "")
    if len(password) < 14:
        raise RuntimeError(
            "MURIKAH_TUTOR_ADMIN_PASSWORD is required on first boot and must be at least 14 characters."
        )

    from deeptutor.services.auth import hash_password

    atomic_write_json(
        AUTH_PATH,
        {
            "version": 1,
            "enabled": True,
            "username": username,
            "password_hash": hash_password(password),
            "token_expire_hours": expire_hours,
            "cookie_secure": True,
        },
    )
    print(f"[Murikah Tutor] Created protected bootstrap admin: {username!r}.")


def harden_system_settings() -> None:
    if SYSTEM_PATH.exists():
        current = json.loads(SYSTEM_PATH.read_text(encoding="utf-8"))
    else:
        current = {"version": 1}

    # A public multi-user service should not execute learner-supplied subprocesses
    # inside the main application container. We can deliberately enable an isolated
    # runner in a later deployment phase.
    if os.environ.get("MURIKAH_TUTOR_ALLOW_MAIN_CONTAINER_EXEC") == "1":
        current["sandbox_allow_subprocess"] = True
        print("[Murikah Tutor] WARNING: main-container subprocess execution explicitly enabled.")
    else:
        current["sandbox_allow_subprocess"] = False

    # Cloudflare and Railway public traffic target Next.js on 3782. FastAPI stays
    # internal to the same container on 8001 and is reached by the server-side proxy.
    current["frontend_port"] = 3782
    current["backend_port"] = 8001
    current["backend_workers"] = 1

    atomic_write_json(SYSTEM_PATH, current)
    print("[Murikah Tutor] Production runtime hardening applied.")


def bootstrap_cloudflare_model_catalog() -> None:
    runtime = optional_env("MURIKAH_TUTOR_RUNTIME")
    if not runtime.startswith("cloudflare-container"):
        return

    nvidia_key = required_env("MURIKAH_NVIDIA_NIM_API_KEY")
    nvidia_base = required_env("MURIKAH_NVIDIA_NIM_BASE_URL")
    primary_model = required_env("MURIKAH_LLM_PRIMARY_MODEL")
    secondary_model = required_env("MURIKAH_LLM_SECONDARY_MODEL")
    tertiary_model = required_env("MURIKAH_LLM_TERTIARY_MODEL")

    dashscope_key = required_env("MURIKAH_DASHSCOPE_API_KEY")
    embedding_provider = required_env("MURIKAH_EMBEDDING_PROVIDER")
    embedding_model = required_env("MURIKAH_EMBEDDING_MODEL")
    embedding_endpoint = required_env("MURIKAH_EMBEDDING_ENDPOINT")
    try:
        embedding_dimension = int(required_env("MURIKAH_EMBEDDING_DIMENSION"))
    except ValueError as exc:
        raise RuntimeError("MURIKAH_EMBEDDING_DIMENSION must be an integer.") from exc
    if embedding_dimension <= 0:
        raise RuntimeError("MURIKAH_EMBEDDING_DIMENSION must be greater than zero.")

    search_provider = required_env("MURIKAH_SEARCH_PROVIDER")
    tavily_key = required_env("MURIKAH_TAVILY_API_KEY")

    tts_provider = required_env("MURIKAH_TTS_PROVIDER")
    tts_model = required_env("MURIKAH_TTS_MODEL")
    tts_voice = required_env("MURIKAH_TTS_VOICE")
    tts_base = required_env("MURIKAH_TTS_BASE_URL")

    stt_provider = required_env("MURIKAH_STT_PROVIDER")
    stt_model = required_env("MURIKAH_STT_MODEL")
    stt_base = required_env("MURIKAH_STT_BASE_URL")

    image_provider = required_env("MURIKAH_IMAGE_PROVIDER")
    image_model = required_env("MURIKAH_IMAGE_MODEL")
    image_base = required_env("MURIKAH_IMAGE_BASE_URL")

    video_provider = required_env("MURIKAH_VIDEO_PROVIDER")
    video_model = required_env("MURIKAH_VIDEO_MODEL")
    video_base = required_env("MURIKAH_VIDEO_BASE_URL")

    llm_models = [
        model_entry(primary_model, "muri-llm-primary"),
        model_entry(secondary_model, "muri-llm-secondary"),
        model_entry(tertiary_model, "muri-llm-tertiary"),
    ]
    task_models = [
        model_entry(primary_model, "muri-task-primary"),
        model_entry(secondary_model, "muri-task-secondary"),
        model_entry(tertiary_model, "muri-task-tertiary"),
    ]

    catalog: dict[str, Any] = {
        "version": 1,
        "connections": [],
        "services": {
            "llm": service_shell(
                "muri-llm-nvidia",
                "muri-llm-primary",
                {
                    "id": "muri-llm-nvidia",
                    "name": "NVIDIA NIM",
                    "binding": "nvidia_nim",
                    "api_key": nvidia_key,
                    "base_url": nvidia_base,
                    "api_version": "",
                    "extra_headers": {},
                    "api_format": "auto",
                    "wire_api": "auto",
                    "models": llm_models,
                },
            ),
            "task": service_shell(
                "muri-task-nvidia",
                "muri-task-primary",
                {
                    "id": "muri-task-nvidia",
                    "name": "NVIDIA NIM",
                    "binding": "nvidia_nim",
                    "api_key": nvidia_key,
                    "base_url": nvidia_base,
                    "api_version": "",
                    "extra_headers": {},
                    "api_format": "auto",
                    "wire_api": "auto",
                    "models": task_models,
                },
            ),
            "embedding": service_shell(
                "muri-embedding",
                "muri-embedding-model",
                {
                    "id": "muri-embedding",
                    "name": "Murikah Embedding",
                    "binding": embedding_provider,
                    "api_key": dashscope_key,
                    "base_url": embedding_endpoint,
                    "api_version": "",
                    "extra_headers": {},
                    "models": [
                        model_entry(
                            embedding_model,
                            "muri-embedding-model",
                            dimension=embedding_dimension,
                        )
                    ],
                },
            ),
            "search": {
                "active_profile_id": "muri-search",
                "profiles": [
                    {
                        "id": "muri-search",
                        "name": "Murikah Search",
                        "provider": search_provider,
                        "api_key": tavily_key,
                        "base_url": "",
                        "api_version": "",
                        "proxy": "",
                        "models": [],
                    }
                ],
            },
            "tts": service_shell(
                "muri-tts",
                "muri-tts-model",
                {
                    "id": "muri-tts",
                    "name": "Murikah Text-to-Speech",
                    "binding": tts_provider,
                    "api_key": dashscope_key,
                    "base_url": tts_base,
                    "api_version": "",
                    "extra_headers": {},
                    "models": [
                        model_entry(tts_model, "muri-tts-model", voice=tts_voice)
                    ],
                },
            ),
            "stt": service_shell(
                "muri-stt",
                "muri-stt-model",
                {
                    "id": "muri-stt",
                    "name": "Murikah Speech-to-Text",
                    "binding": stt_provider,
                    "api_key": dashscope_key,
                    "base_url": stt_base,
                    "api_version": "",
                    "extra_headers": {},
                    "models": [model_entry(stt_model, "muri-stt-model")],
                },
            ),
            "imagegen": service_shell(
                "muri-image",
                "muri-image-model",
                {
                    "id": "muri-image",
                    "name": "Murikah Image Generation",
                    "binding": image_provider,
                    "api_key": dashscope_key,
                    "base_url": image_base,
                    "api_version": "",
                    "extra_headers": {},
                    "models": [model_entry(image_model, "muri-image-model")],
                },
            ),
            "videogen": service_shell(
                "muri-video",
                "muri-video-model",
                {
                    "id": "muri-video",
                    "name": "Murikah Video Generation",
                    "binding": video_provider,
                    "api_key": dashscope_key,
                    "base_url": video_base,
                    "api_version": "",
                    "extra_headers": {},
                    "models": [model_entry(video_model, "muri-video-model")],
                },
            ),
        },
    }

    # DeepTutor normalizes this file when it loads it. Stable ids ensure the UI
    # does not accumulate duplicate providers/models after sleep or replacement.
    atomic_write_json(MODEL_CATALOG_PATH, catalog)
    print(
        "[Murikah Tutor] Rebuilt Cloudflare-managed model catalog "
        "(LLM/task/embedding/search/TTS/STT/image/video)."
    )


def bootstrap_cloudflare_video_learning() -> None:
    runtime = optional_env("MURIKAH_TUTOR_RUNTIME")
    if not runtime.startswith("cloudflare-container"):
        return

    provider = required_env("MURIKAH_VIDEO_LEARNING_PROVIDER").lower()
    transcript_provider = required_env("MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER")
    if provider not in {"youtube", "invidious"}:
        raise RuntimeError(
            "MURIKAH_VIDEO_LEARNING_PROVIDER must be 'youtube' or 'invidious'."
        )
    if transcript_provider not in {"youtube_transcript_api", "none"}:
        raise RuntimeError(
            "MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER must be "
            "'youtube_transcript_api' or 'none'."
        )

    invidious_api = optional_env("MURIKAH_INVIDIOUS_API_BASE_URL")
    invidious_public = optional_env("MURIKAH_INVIDIOUS_PUBLIC_BASE_URL")
    if provider == "invidious" and not invidious_api:
        raise RuntimeError(
            "MURIKAH_INVIDIOUS_API_BASE_URL is required when Invidious is selected."
        )

    atomic_write_json(
        VIDEO_LEARNING_PATH,
        {
            "version": 1,
            "default_provider": provider,
            "youtube": {"transcript_provider": transcript_provider},
            "invidious": {
                "api_base_url": invidious_api,
                "public_base_url": invidious_public,
            },
        },
    )
    print("[Murikah Tutor] Rebuilt Cloudflare-managed Video Learning settings.")


def main() -> None:
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    bootstrap_auth()
    harden_system_settings()
    bootstrap_cloudflare_model_catalog()
    bootstrap_cloudflare_video_learning()


if __name__ == "__main__":
    main()
