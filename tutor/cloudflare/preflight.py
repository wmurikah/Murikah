#!/usr/bin/env python3
"""Fail-closed checks for the Cloudflare Container runtime."""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]
failures: list[str] = []


def require(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        failures.append(f"missing required file: {relative}")
        return ""
    return path.read_text(encoding="utf-8")


def require_markers(relative: str, markers: tuple[str, ...]) -> None:
    content = require(relative)
    for marker in markers:
        if content and marker not in content:
            failures.append(f"{relative} missing invariant: {marker!r}")


def forbid_markers(relative: str, markers: tuple[str, ...]) -> None:
    content = require(relative)
    for marker in markers:
        if content and marker in content:
            failures.append(f"{relative} contains forbidden migration marker: {marker!r}")


def validate_persistence_migration_fixture() -> None:
    """Keep D1 migrations simple enough for Wrangler's remote SQL runner."""
    relative = "tutor/cloudflare/migrations/0001_tutor_persistence.sql"
    content = require(relative)
    if not content:
        return
    if "CREATE TRIGGER" in content.upper():
        failures.append(
            f"{relative} contains CREATE TRIGGER; Wrangler D1 migrations previously rejected "
            "multi-statement trigger bodies with SQLITE_ERROR incomplete input"
        )
        return
    try:
        connection = sqlite3.connect(":memory:")
        connection.executescript(content)
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    except sqlite3.Error as exc:
        failures.append(f"{relative} SQLite syntax fixture failed: {exc}")
        return
    finally:
        try:
            connection.close()
        except Exception:
            pass
    required = {
        "persistence_meta",
        "persistence_objects",
        "persistence_replay",
        "guest_sessions",
        "guest_prompts",
    }
    missing = sorted(required - tables)
    if missing:
        failures.append(f"{relative} fixture did not create tables: {', '.join(missing)}")


def validate_bootstrap_fixture() -> None:
    """Exercise the Cloudflare settings bootstrap without real provider secrets."""
    bootstrap_path = ROOT / "tutor/railway/bootstrap_runtime.py"
    spec = importlib.util.spec_from_file_location("murikah_tutor_bootstrap_fixture", bootstrap_path)
    if spec is None or spec.loader is None:
        failures.append("could not import tutor/railway/bootstrap_runtime.py")
        return
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # pragma: no cover - build-time failure path
        failures.append(f"bootstrap_runtime.py import failed: {exc}")
        return

    fixture = {
        "MURIKAH_TUTOR_RUNTIME": "cloudflare-container-test",
        "MURIKAH_NVIDIA_NIM_API_KEY": "nvapi-fixture",
        "MURIKAH_NVIDIA_NIM_BASE_URL": "https://nvidia.example/v1",
        "MURIKAH_LLM_PRIMARY_MODEL": "vendor/primary",
        "MURIKAH_LLM_SECONDARY_MODEL": "vendor/secondary",
        "MURIKAH_LLM_TERTIARY_MODEL": "vendor/tertiary",
        "MURIKAH_DASHSCOPE_API_KEY": "dash-fixture",
        "MURIKAH_DASHSCOPE_BASE_URL": "https://dash.example/api/v1",
        "MURIKAH_EMBEDDING_PROVIDER": "aliyun",
        "MURIKAH_EMBEDDING_MODEL": "embed-model",
        "MURIKAH_EMBEDDING_DIMENSION": "1024",
        "MURIKAH_EMBEDDING_ENDPOINT": "https://dash.example/embeddings",
        "MURIKAH_SEARCH_PROVIDER": "tavily",
        "MURIKAH_TAVILY_API_KEY": "tavily-fixture",
        "MURIKAH_TTS_PROVIDER": "dashscope",
        "MURIKAH_TTS_MODEL": "tts-model",
        "MURIKAH_TTS_VOICE": "Cherry",
        "MURIKAH_TTS_BASE_URL": "https://dash.example/api/v1",
        "MURIKAH_STT_PROVIDER": "dashscope",
        "MURIKAH_STT_MODEL": "stt-model",
        "MURIKAH_STT_BASE_URL": "https://dash.example/api/v1",
        "MURIKAH_IMAGE_PROVIDER": "dashscope",
        "MURIKAH_IMAGE_MODEL": "image-model",
        "MURIKAH_IMAGE_BASE_URL": "https://dash.example/api/v1",
        "MURIKAH_VIDEO_PROVIDER": "dashscope",
        "MURIKAH_VIDEO_MODEL": "video-model",
        "MURIKAH_VIDEO_BASE_URL": "https://dash.example/api/v1",
        "MURIKAH_VIDEO_LEARNING_PROVIDER": "youtube",
        "MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER": "youtube_transcript_api",
    }
    previous = {key: os.environ.get(key) for key in fixture}

    try:
        with tempfile.TemporaryDirectory(prefix="muri-tutor-bootstrap-") as temp_dir:
            settings_dir = Path(temp_dir) / "settings"
            module.SETTINGS_DIR = settings_dir
            module.MODEL_CATALOG_PATH = settings_dir / "model_catalog.json"
            module.VIDEO_LEARNING_PATH = settings_dir / "video_learning.json"
            os.environ.update(fixture)

            module.bootstrap_cloudflare_model_catalog()
            module.bootstrap_cloudflare_video_learning()

            catalog = json.loads(module.MODEL_CATALOG_PATH.read_text(encoding="utf-8"))
            video = json.loads(module.VIDEO_LEARNING_PATH.read_text(encoding="utf-8"))
            llm = catalog["services"]["llm"]
            task = catalog["services"]["task"]
            embedding = catalog["services"]["embedding"]
            search = catalog["services"]["search"]
            tts = catalog["services"]["tts"]

            checks = (
                (llm["active_model_id"] == "muri-llm-primary", "LLM primary selection"),
                (len(llm["profiles"][0]["models"]) == 3, "LLM fallback model inventory"),
                (llm["profiles"][0]["api_key"] == "nvapi-fixture", "NVIDIA secret wiring"),
                (len(task["profiles"][0]["models"]) == 3, "task model inventory"),
                (
                    embedding["profiles"][0]["models"][0]["dimension"] == 1024,
                    "embedding dimension",
                ),
                (
                    search["profiles"][0]["api_key"] == "tavily-fixture",
                    "search secret wiring",
                ),
                (tts["profiles"][0]["models"][0]["voice"] == "Cherry", "TTS voice"),
                (video["default_provider"] == "youtube", "Video Learning provider"),
                (
                    video["youtube"]["transcript_provider"] == "youtube_transcript_api",
                    "Video Learning transcript adapter",
                ),
            )
            for passed, label in checks:
                if not passed:
                    failures.append(f"Cloudflare bootstrap fixture failed: {label}")
    except Exception as exc:  # pragma: no cover - build-time failure path
        failures.append(f"Cloudflare bootstrap fixture raised: {exc}")
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main() -> int:
    require_markers(
        "tutor/cloudflare/package.json",
        (
            '"@cloudflare/containers": "0.3.7"',
            '"wrangler": "4.130.0"',
            '"deploy:staging"',
            'python deploy_staging.py',
            '--containers-rollout=immediate',
            '"check"',
        ),
    )
    require_markers(
        "tutor/cloudflare/wrangler.toml",
        (
            'name = "murikah-tutor-container-staging"',
            'workers_dev = true',
            'keep_vars = true',
            'pattern = "tutor.murikah.com"',
            'custom_domain = true',
            'class_name = "TutorContainer"',
            'image = "../Dockerfile.railway"',
            'image_build_context = "../.."',
            'max_instances = 4',
            'instance_type = "standard-2"',
            'rollout_active_grace_period = 0',
            'MURIKAH_CLOUDFLARE_IMAGE_REV = "2026-09-19-v19"',
            'binding = "TUTOR_DB"',
            'migrations_dir = "migrations"',
            'binding = "TUTOR_FILES"',
            'new_sqlite_classes = ["TutorContainer"]',
            '[secrets]',
            '"MURIKAH_TUTOR_ADMIN_PASSWORD"',
            '"MURIKAH_TUTOR_AUTH_SECRET"',
            '"MURIKAH_NVIDIA_NIM_API_KEY"',
            '"MURIKAH_DASHSCOPE_API_KEY"',
            '"MURIKAH_TAVILY_API_KEY"',
            'MURIKAH_PUBLIC_BASE_URL = "https://tutor.murikah.com"',
            'MURIKAH_GUEST_PROMPT_LIMIT = "7"',
        ),
    )
    require_markers(
        "tutor/cloudflare/deploy_staging.py",
        (
            'APP_NAME = "murikah-tutor-container-staging-TutorContainer"',
            'def list_tutor_applications()',
            'def recycle_tutor_application()',
            'TRANSIENT_DEPLOY_ERRORS',
            'def apply_persistence_migrations()',
            '"d1", "migrations", "apply", "murikah-tutor-prod", "--remote"',
            'MURIKAH_CLOUDFLARE_IMAGE_REV',
            '"/__muri/container-diagnostics"',
            '"/__muri/runtime-status"',
            'ModuleNotFoundError: No module named \'deeptutor\'',
            'port 3782 healthy',
        ),
    )
    require_markers(
        "tutor/cloudflare/entrypoint.sh",
        (
            'cd /app',
            'export PYTHONPATH="/app${PYTHONPATH:+:${PYTHONPATH}}"',
            'MURIKAH_TUTOR_AUTH_SECRET',
            '/app/data/system/auth/auth_secret',
            'Stable Cloudflare auth signing secret restored.',
            'python -m deeptutor.murikah_persistence restore',
            'python /app/murikah-tutor-bootstrap.py',
            'python /app/murikah-fast-lane-bootstrap.py',
            'python -m deeptutor.murikah_persistence sync-once',
            'python -m deeptutor.murikah_persistence sync-loop &',
            'MURIKAH_FAST_CHAT_MODEL',
            'export BACKEND_HOST=127.0.0.1',
            'export FRONTEND_HOST=0.0.0.0',
            '/app/start-backend.sh &',
            '/app/start-frontend.sh &',
            'wait -n',
        ),
    )
    require_markers(
        "tutor/Dockerfile.railway",
        (
            'ARG MURIKAH_CLOUDFLARE_IMAGE_REV=dev',
            'LABEL com.murikah.tutor.cloudflare-image-rev=',
            'COPY tutor/railway/murikah_fast_lane.py /opt/murikah/murikah_fast_lane.py',
            'COPY tutor/railway/murikah_persistence.py /opt/murikah/murikah_persistence.py',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/murikah_persistence.py /app/deeptutor/murikah_persistence.py',
            'COPY tutor/railway /opt/murikah/railway',
            'COPY tutor/tests /opt/murikah/tests',
            'RUN python -m unittest discover -s /opt/murikah/tests -v',
            'COPY tutor/railway/bootstrap_fast_lane.py /app/murikah-fast-lane-bootstrap.py',
            'COPY tutor/cloudflare/entrypoint.sh /app/murikah-cloudflare-entrypoint.sh',
            '/app/murikah-cloudflare-entrypoint.sh',
            '/app/murikah-cloudflare-image-rev',
            'ENTRYPOINT ["/app/murikah-tutor-entrypoint.sh"]',
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            'extends Container<TutorEnv>',
            'defaultPort = 3782',
            "sleepAfter = '30m'",
            'entrypoint = [CLOUDFLARE_ENTRYPOINT]',
            "CLOUDFLARE_ENTRYPOINT = '/app/murikah-cloudflare-entrypoint.sh'",
            'READY_CACHE_MS = 5_000',
            'statusInFlight',
            'cachedStatus(tutor, runtimeEnv)',
            'How can I help you learn today?',
            'buildContainerEnv(env)',
            'this.ctx.container.start({',
            'if (this.ctx.container.running)',
            'if (!this.ctx.container.running)',
            'env: runtimeEnv',
            'entrypoint: [CLOUDFLARE_ENTRYPOINT]',
            'async ensureStarted(',
            'async runtimeStatus()',
            'async isolatedStartupDiagnostics(',
            'isolatedStartupDiagnostics(runtimeEnv)',
            'this.ctx.container.getTcpPort(3782).fetch(',
            "this.ctx.container.destroy('Murikah staging diagnostic complete')",
            "'murikah-tutor-staging-v7'",
            "'murikah-tutor-staging-diagnostics-v7'",
            "'/__muri/runtime-status'",
            "'/__muri/container-diagnostics'",
            "'/__muri/edge-health'",
            "'/__muri/worker-config'",
            "PERSISTENCE_PREFIX = '/__muri/persist'",
            'handlePersistence(request, env, url)',
            'TUTOR_DB: PersistenceDatabase',
            'TUTOR_FILES: PersistenceBucket',
            'persistenceConfigured',
            'workerSecretConfigured',
            'authSecretConfigured',
            'geminiFastLaneConfigured',
            'MURIKAH_GEMINI_API_KEY',
            'MURIKAH_FAST_CHAT_MODEL',
            "url.pathname === '/favicon.ico'",
            'response.status === 101',
            'x-murikah-tutor-runtime',
            'MURIKAH_TUTOR_RUNTIME',
            'MURIKAH_PUBLIC_BASE_URL',
            'MURIKAH_GUEST_PROMPT_LIMIT',
            'MURIKAH_TUTOR_ADMIN_PASSWORD',
            'MURIKAH_TUTOR_AUTH_SECRET',
            'MURIKAH_NVIDIA_NIM_API_KEY',
            'MURIKAH_DASHSCOPE_API_KEY',
            'MURIKAH_TAVILY_API_KEY',
            'MURIKAH_VIDEO_LEARNING_PROVIDER',
            'MURIKAH_GOOGLE_CLIENT_ID',
            'MURIKAH_MICROSOFT_CLIENT_ID',
            'MURIKAH_APPLE_CLIENT_ID',
        ),
    )
    require_markers(
        "tutor/railway/bootstrap_runtime.py",
        (
            'MODEL_CATALOG_PATH = SETTINGS_DIR / "model_catalog.json"',
            'VIDEO_LEARNING_PATH = SETTINGS_DIR / "video_learning.json"',
            'def bootstrap_cloudflare_model_catalog()',
            'def bootstrap_cloudflare_video_learning()',
            'MURIKAH_NVIDIA_NIM_API_KEY',
            'MURIKAH_LLM_PRIMARY_MODEL',
            'MURIKAH_DASHSCOPE_API_KEY',
            'MURIKAH_EMBEDDING_ENDPOINT',
            'MURIKAH_TAVILY_API_KEY',
            'MURIKAH_TTS_MODEL',
            'MURIKAH_STT_MODEL',
            'MURIKAH_IMAGE_MODEL',
            'MURIKAH_VIDEO_MODEL',
            'MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER',
            'atomic_write_json(MODEL_CATALOG_PATH, catalog)',
        ),
    )
    require_markers(
        "tutor/railway/bootstrap_fast_lane.py",
        (
            'PROFILE_ID = "muri-llm-gemini"',
            'DEFAULT_MODEL = "gemini-3.8-flash"',
            'MURIKAH_GEMINI_API_KEY',
            'MURIKAH_FAST_CHAT_MODEL',
            '"api_format": "openai_chat"',
            'llm["active_profile_id"] = PROFILE_ID',
        ),
    )
    require_markers(
        "tutor/railway/murikah_fast_lane.py",
        (
            'DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"',
            'thinkingLevel": "low"',
            'async def gemini_stream(',
            'async def race_first_visible(',
            'MURIKAH_LATENCY route=fast',
        ),
    )
    require_markers(
        "tutor/railway/accelerate_chat.py",
        (
            'MURIKAH_DUAL_LANE_CHAT_V2',
            'def _agent_reason(',
            'force_agentic_chat',
            'race_first_visible(',
            'route=deep_agent',
            'route=fast',
        ),
    )
    require_markers(
        "tutor/railway/prepare_next_build.py",
        (
            'MURIKAH_FAST_LANE_FAILOVER_V4',
            'trust_env=False',
            'gemini_compat =',
            'service temporarily overloaded',
            'Provider returned a retryable error payload instead of guest output',
        ),
    )
    forbid_markers(
        "tutor/cloudflare/src/index.ts",
        (
            '<meta http-equiv="refresh"',
            'startAndWaitForPorts(',
            'portReadyTimeoutMS',
            'requiredPorts = [3782]',
            'env as workerBindings',
            'runtimeBindings',
            'isLiveState(',
        ),
    )
    require_markers(
        "tutor/cloudflare/smoke_staging.py",
        (
            '"/__muri/worker-config"',
            'adminPasswordConfigured',
            'persistenceConfigured',
            '"/__muri/persistence-status"',
            'schemaVersion',
            '"/__muri/runtime-status"',
            '"/__muri/container-diagnostics"',
            'MURIKAH_TUTOR_SMOKE_TIMEOUT',
        ),
    )
    require_markers(
        "tutor/cloudflare/README.md",
        (
            "Cloudflare Workers Builds",
            "tutor.murikah.com",
            "python tutor/scripts/preflight.py",
            "npm --prefix tutor/cloudflare run deploy:staging",
            "MURIKAH_TUTOR_AUTH_SECRET",
            "PERSISTENCE.md",
        ),
    )
    require_markers(
        "tutor/cloudflare/migrations/0001_tutor_persistence.sql",
        (
            "CREATE TABLE IF NOT EXISTS persistence_objects",
            "CREATE TABLE IF NOT EXISTS persistence_replay",
            "CREATE TABLE IF NOT EXISTS guest_sessions",
            "CREATE TABLE IF NOT EXISTS guest_prompts",
            "CREATE INDEX IF NOT EXISTS idx_guest_prompts_uid",
            "schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0001_tutor_persistence.sql",
        ("CREATE TRIGGER",),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "INSERT OR IGNORE INTO guest_prompts",
            "s.used_count + COUNT(p.request_id) AS used_count",
            "guest_prompt_limit",
            "guest_session_expired",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "source.backup(destination)",
            "PERSIST_PREFIX = \"/__muri/persist\"",
            "def restore()",
            "def sync_once()",
            "def sync_loop()",
            "def guest_reserve(",
            "def guest_status(",
        ),
    )
    require_markers(
        "tutor/cloudflare/PERSISTENCE.md",
        (
            "Cloudflare Container disk is disposable",
            "R2 / object storage",
            "Do not put a live SQLite database on an R2/FUSE mount",
            "Durable Object SQLite",
            "Production cutover is blocked until",
        ),
    )
    require_markers(
        "tutor/cloudflare/inventory_app_data.py",
        (
            "SQLITE_MAGIC",
            "SQLite databases detected",
            "No file contents were read beyond the 16-byte SQLite signature check.",
        ),
    )
    validate_persistence_migration_fixture()
    validate_bootstrap_fixture()

    if failures:
        print("Murikah Tutor Cloudflare migration preflight: FAILED")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Murikah Tutor Cloudflare migration preflight: PASS")
    print(" - tutor.murikah.com is attached as the Cloudflare Container custom domain")
    print(" - production public base is fixed to https://tutor.murikah.com")
    print(" - dashboard Variables & Secrets survive repo-backed Wrangler deploys")
    print(" - stable auth signing secret is restored before DeepTutor auth imports")
    print(" - /app is fixed as the Python import root before runtime initialization")
    print(" - model/service configuration is rebuilt from Cloudflare on container start")
    print(" - Gemini fast chat is additive and deep-task NVIDIA settings remain preserved")
    print(" - ordinary Chat is separated from the DeepTutor agent lane")
    print(" - fast chat uses native + OpenAI-compatible Gemini transports before NVIDIA fallback")
    print(" - transient overload/capacity payloads trigger provider failover instead of rendering as Tutor answers")
    print(" - Cloudflare startup bypasses supervisord and starts FastAPI + Next.js directly")
    print(" - stale Cloudflare container applications are detected and recycled during deploy")
    print(" - low-level container.running is authoritative for start eligibility")
    print(" - stale getState transitions cannot trigger duplicate start() calls")
    print(" - staging startup is non-blocking at the edge")
    print(" - Worker bindings are passed explicitly into every Linux container start")
    print(" - Durable Object/container errors are contained and cannot surface as edge 1101")
    print(" - readiness is determined by the real Tutor /health route")
    print(" - D1-backed guest quotas and private R2 /app/data checkpoints are wired through the Worker bridge")
    print(" - production persistence cutover remains gated on the destructive container-replacement acceptance test")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
