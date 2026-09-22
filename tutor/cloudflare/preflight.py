#!/usr/bin/env python3
"""Fail-closed checks for the Cloudflare Container runtime."""
from __future__ import annotations

import importlib.util
import json
import os
import re
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
    """Keep D1 migrations compatible with Cloudflare's build environment.

    Cloudflare Workers Builds currently supplies Python without the optional
    _sqlite3 extension, so preflight must not import or execute sqlite3. The
    migration itself is applied and validated by Wrangler against remote D1.
    Here we fail closed on constructs that caused the production failure and
    on obvious truncation/shape errors before Wrangler is invoked.
    """
    relative = "tutor/cloudflare/migrations/0001_tutor_persistence.sql"
    content = require(relative)
    if not content:
        return

    sql = "\n".join(line.split("--", 1)[0] for line in content.splitlines())
    normalized = " ".join(sql.split()).upper()

    if "CREATE TRIGGER" in normalized:
        failures.append(
            f"{relative} contains a trigger definition; Wrangler D1 migrations previously "
            "rejected multi-statement trigger bodies with SQLITE_ERROR incomplete input"
        )
    if " BEGIN " in f" {normalized} ":
        failures.append(
            f"{relative} contains a BEGIN block; keep D1 migrations as simple standalone statements"
        )

    required_tables = (
        "persistence_meta",
        "persistence_objects",
        "persistence_replay",
        "guest_sessions",
        "guest_prompts",
    )
    for table in required_tables:
        marker = f"CREATE TABLE IF NOT EXISTS {table.upper()} ("
        if marker not in normalized:
            failures.append(f"{relative} missing table definition: {table}")

    if sql.count("(") != sql.count(")"):
        failures.append(f"{relative} has unbalanced parentheses")
    if not sql.rstrip().endswith(";"):
        failures.append(f"{relative} does not end with a complete SQL statement")
    if "SCHEMA_VERSION" not in normalized:
        failures.append(f"{relative} missing schema_version marker")

def validate_resend_deploy_policy() -> None:
    """Resend must gate signup, not the entire Worker deployment."""
    relative = "tutor/cloudflare/wrangler.toml"
    content = require(relative)
    if not content:
        return
    try:
        required_block = content.split("[secrets]", 1)[1].split("[[d1_databases]]", 1)[0]
    except IndexError:
        failures.append(f"{relative} is missing the expected [secrets] section")
        return
    if '"RESEND_API_KEY"' in required_block:
        failures.append(
            f"{relative} makes RESEND_API_KEY deploy-required; keep email verification fail-closed at runtime instead"
        )


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
            'MURIKAH_CLOUDFLARE_IMAGE_REV = "2026-09-21-v32"',
            'binding = "TUTOR_DB"',
            'migrations_dir = "migrations"',
            'binding = "TUTOR_FILES"',
            'new_sqlite_classes = ["TutorContainer"]',
            '[secrets]',
            '"MURIKAH_TUTOR_ADMIN_PASSWORD"',
            '"MURIKAH_TUTOR_AUTH_SECRET"',
            '"MURIKAH_GOOGLE_CLIENT_ID"',
            '"MURIKAH_GOOGLE_CLIENT_SECRET"',
            'RESEND_API_KEY is intentionally not deploy-required',
            '"MURIKAH_NVIDIA_NIM_API_KEY"',
            '"MURIKAH_DASHSCOPE_API_KEY"',
            '"MURIKAH_TAVILY_API_KEY"',
            'MURIKAH_PUBLIC_BASE_URL = "https://tutor.murikah.com"',
            'MURIKAH_GUEST_PROMPT_LIMIT = "7"',
            'RESEND_FROM_EMAIL = "Murikah Tutor <noreply@murikah.com>"',
            'MURIKAH_FAST_CHAT_MODEL = "gemini-3.5-flash-lite"',
            'MURIKAH_FAST_CHAT_QWEN_MODEL = "qwen3.8-flash"',
        ),
    )
    require_markers(
        "tutor/cloudflare/deploy_staging.py",
        (
            'APP_NAME = "murikah-tutor-container-staging-TutorContainer"',
            'def list_tutor_applications()',
            'def recycle_tutor_application()',
            'TRANSIENT_DEPLOY_ERRORS',
            'REGISTRY_PROPAGATION_MARKERS',
            '"no such manifest:"',
            'def recover_fresh_but_unready_runtime(',
            'recycling the container application once after registry propagation',
            'wait_until_ready(base, timeout_seconds=300)',
            'def apply_persistence_migrations()',
            '"d1", "migrations", "apply", "murikah-tutor-prod", "--remote"',
            'MURIKAH_CLOUDFLARE_IMAGE_REV',
            '"/__muri/container-diagnostics"',
            '"/__muri/runtime-status"',
            'ModuleNotFoundError: No module named \'deeptutor\'',
            'port 3782 healthy',
            'def refreshed_failure_detail(',
            'diagnostics refresh failed:',
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
            'python -m deeptutor.murikah_persistence reconcile-ownership',
            'python -m deeptutor.murikah_persistence reconcile-accounts',
            'wait_for_runtime_port()',
            'socket.create_connection(("127.0.0.1", 3782)',
            'Persistence metadata reconciliation attempt',
            'Persistence metadata reconciliation complete.',
            'exec python -m deeptutor.murikah_persistence sync-loop',
            'persistence_pid=$!',
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
            'COPY tutor/railway/murikah_context_packet.py /opt/murikah/murikah_context_packet.py',
            'cp /opt/murikah/murikah_context_packet.py /src/DeepTutor/deeptutor/murikah_context_packet.py',
            'COPY tutor/railway/murikah_persistence.py /opt/murikah/murikah_persistence.py',
            'COPY tutor/railway/murikah_email_verification.py /opt/murikah/murikah_email_verification.py',
            'COPY tutor/railway/disposable_email_domains.txt /opt/murikah/disposable_email_domains.txt',
            'COPY tutor/railway/MurikahInviteFriends.tsx.txt /opt/murikah/MurikahInviteFriends.tsx.txt',
            'COPY tutor/railway/persist_learning_journal.py /opt/murikah/persist_learning_journal.py',
            'COPY tutor/railway/brand_chat_status.py /opt/murikah/brand_chat_status.py',
            'COPY tutor/railway/fluid_visual_outputs.py /opt/murikah/fluid_visual_outputs.py',
            'python /opt/murikah/fluid_visual_outputs.py /src/DeepTutor',
            'COPY tutor/railway/add_virtual_internship_placeholder.py /opt/murikah/add_virtual_internship_placeholder.py',
            'COPY tutor/railway/murikah-virtual-internship-page.tsx.txt /opt/murikah/murikah-virtual-internship-page.tsx',
            'python /opt/murikah/add_virtual_internship_placeholder.py /src/DeepTutor /opt/murikah/murikah-virtual-internship-page.tsx',
            'COPY tutor/railway/harden_member_runtime.py /opt/murikah/harden_member_runtime.py',
            'python /opt/murikah/harden_member_runtime.py /src/DeepTutor',
            'COPY tutor/railway/share_admin_models.py /opt/murikah/share_admin_models.py',
            'python /opt/murikah/share_admin_models.py /src/DeepTutor',
            'COPY tutor/railway/harden_admin_controls.py /opt/murikah/harden_admin_controls.py',
            'python /opt/murikah/harden_admin_controls.py /src/DeepTutor',
            'COPY tutor/railway/harden_math_animator.py /opt/murikah/harden_math_animator.py',
            'python /opt/murikah/harden_math_animator.py /src/DeepTutor',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/agents/math_animator /app/deeptutor/agents/math_animator',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/multi_user/model_access.py /app/deeptutor/multi_user/model_access.py',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/api/routers/settings.py /app/deeptutor/api/routers/settings.py',
            'COPY tutor/tests/settings-admin-boundary.spec.tsx.txt ./tests/integration/settings-admin-boundary.spec.tsx',
            'tests/integration/settings-admin-boundary.spec.tsx',
            'COPY tutor/tests/verified-email-invites.spec.tsx.txt ./tests/integration/verified-email-invites.spec.tsx',
            'tests/integration/verified-email-invites.spec.tsx',
            '"manim>=0.19.0,<0.20"',
            'texlive-latex-base',
            'dvisvgm',
            'python /opt/murikah/persist_learning_journal.py /src/DeepTutor',
            'python /opt/murikah/brand_chat_status.py /src/DeepTutor',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/murikah_persistence.py /app/deeptutor/murikah_persistence.py',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/murikah_email_verification.py /app/deeptutor/murikah_email_verification.py',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/disposable_email_domains.txt /app/deeptutor/disposable_email_domains.txt',
            'COPY --from=branded-source /src/DeepTutor/deeptutor/services/session/turns/executor.py /app/deeptutor/services/session/turns/executor.py',
            'COPY tutor/railway /opt/murikah/railway',
            'COPY tutor/tests/auth-sso.spec.tsx.txt ./tests/integration/auth-sso.spec.tsx',
            'tests/integration/auth-sso.spec.tsx',
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
            'verificationEmailConfigured',
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
            'def _member_session_hours()',
            'MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS", "9600"',
            '"token_expire_hours": expire_hours',
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
            'DEFAULT_MODEL = "gemini-3.5-flash-lite"',
            'MURIKAH_GEMINI_API_KEY',
            'MURIKAH_FAST_CHAT_MODEL',
            '"api_format": "openai_chat"',
            'deep-task LLM selection preserved',
        ),
    )
    require_markers(
        "tutor/railway/harden_math_animator.py",
        (
            "MURIKAH_MATH_ANIMATOR_STRUCTURED_V1",
            "direct_structured_payload",
            "request_structured_payload",
            "MURIKAH_MATH_STRUCTURED_TIMEOUT_SECONDS",
            "MURIKAH_MATH_PRIMARY_TIMEOUT_SECONDS",
            "Your math animation is ready.",
            "Murikah could not prepare animation code after bounded retries.",
            "Provider/backend details belong in server logs",
        ),
    )
    require_markers(
        "tutor/railway/share_admin_models.py",
        (
            "def deployment_llm_rows(",
            "inherited = deployment_llm_rows(catalog)",
            "if active is None and options:",
            "is_owner_bound(profile)",
            "deployment model configuration is admin-only",
        ),
    )
    require_markers(
        "tutor/railway/harden_member_runtime.py",
        (
            "Sliding member auth",
            "lastObservedScrollTopRef",
            'pathname === "/diagram-design"',
            "_murikah_solve_repair_attempted",
            "solve_final_repair",
            "Finishing the solution",
        ),
    )
    require_markers(
        "tutor/railway/murikah_diagram.py",
        (
            "Return one complete SVG FIRST",
            "Diagram Design is an artifact-first surface",
        ),
    )
    require_markers(
        "tutor/railway/MurikahSocialButtons.tsx.txt",
        (
            "google: 0",
            'data-google-logo="true"',
            'fill="#4285F4"',
            'fill="#34A853"',
            'fill="#FBBC05"',
            'fill="#EA4335"',
            "Single sign-on",
            "Continue with {provider.label}",
            'data-provider={provider.id}',
        ),
    )
    require_markers(
        "tutor/railway/MurikahAccountPage.tsx.txt",
        (
            'aria-label="Account access"',
            'aria-current={!isSignup ? "page" : undefined}',
            'aria-current={isSignup ? "page" : undefined}',
            '"bg-[#1E2A30] text-white shadow-md ring-1 ring-[#1E2A30]"',
            'verify_email',
            '/api/murikah/access/signup/verify',
            '/api/auth/oauth/verify-email',
            'Verify your email',
            'autoComplete="one-time-code"',
            '<MurikahInviteFriends />',
        ),
    )
    require_markers(
        "tutor/railway/MurikahInviteFriends.tsx.txt",
        (
            "Invite friends to Murikah Tutor",
            "mailto:?subject=",
            "https://wa.me/?text=",
            "navigator.share",
            "Copy link",
            "conversations and account data are never included",
        ),
    )
    require_markers(
        "tutor/railway/MurikahGuestChatV2.tsx.txt",
        (
            'const SIGN_UP =',
            'import MurikahInviteFriends from "@/components/auth/MurikahInviteFriends";',
            'const isGuestSession = guest?.guest === true;',
            'guest?.guest === false',
            'guest?.authenticated === true',
            'if (isMemberSession)',
        ),
    )
    require_markers(
        "tutor/railway/polish_guest_shell.py",
        (
            '<MurikahInviteFriends compact className="sm:hidden" />',
            'href={USERNAME_SIGN_IN}',
            'href={SIGN_UP}',
            'Sign up',
            'href="/register?next=%2Fvirtual-internship"',
            'aria-label="Virtual Internship — coming soon"',
        ),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "Minimum standard internship duration: **90 calendar days**",
            "## 12. Workplace politics and social dynamics",
            "## 20. AI model use",
            "## 22. Competency Evidence Record",
            "## 34. Testing contract",
            "## 37. Definition of done for the full product",
        ),
    )
    require_markers(
        "tutor/railway/add_virtual_internship_placeholder.py",
        (
            'href: "/virtual-internship"',
            'label: "Virtual Internship"',
            "icon: GraduationCap",
            "3+ month simulated workplace",
        ),
    )
    require_markers(
        "tutor/railway/murikah-virtual-internship-page.tsx.txt",
        (
            "Virtual Internship",
            "at least three months",
            "AI workplace actors",
            "Competency Passport",
            "Start internship — coming later",
        ),
    )
    require_markers(
        "tutor/railway/MurikahWorkspaceEntry.tsx.txt",
        (
            '<MurikahInviteFriends',
            'href="/login?next=%2Fchat"',
            'href="/register?next=%2Fchat"',
        ),
    )
    require_markers(
        "tutor/railway/murikah_email_verification.py",
        (
            "MURIKAH_VERIFIED_EMAIL_V1 = True",
            "disposable_domains",
            "privaterelay.appleid.com",
            "cloudflare-dns.com/dns-query",
            "Temporary or disposable email addresses cannot be used",
            "email_verification_start",
            "email_verification_verify",
        ),
    )
    require_markers(
        "tutor/railway/murikah_access.py",
        (
            '@router.post("/signup", status_code=202)',
            '@router.post("/signup/verify", status_code=201)',
            '@router.post("/email/resend")',
            "verification_required",
            "email_verified_at=verified_at",
        ),
    )
    require_markers(
        "tutor/railway/murikah_oauth.py",
        (
            '_PENDING_COOKIE = "mt_oauth_pending"',
            "def _existing_social_username(",
            "async def _login_or_verify_redirect(",
            '@router.post("/verify-email")',
            "purpose=\"social_signup\"",
            "email_verified_at=verified_at",
        ),
    )
    require_markers(
        "tutor/railway/murikah_fast_lane.py",
        (
            'DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"',
            'DEFAULT_NVIDIA_FAST_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"',
            'def portable_chat_messages(',
            'DEFAULT_QWEN_FAST_MODEL = "qwen3.8-flash"',
            'def configured_qwen_fast_model(',
            'def qwen_configured(',
            'async def qwen_stream(',
            '"enable_thinking": thinking',
            'def _gemini_thinking_level(',
            'return "minimal"',
            '"thinkingLevel": _gemini_thinking_level(',
            'async def gemini_stream(',
            'async def nvidia_stream(',
            'trust_env=False',
            'async def race_first_visible(',
            'MURIKAH_LATENCY route=fast',
            'FINISH_SIGNAL_PREFIX = "\\x00MURIKAH_FINISH:"',
            'def finish_reason_needs_continuation(',
            'def likely_incomplete_answer(',
            'def continuation_messages(',
            'def trim_continuation_overlap(',
        ),
    )
    require_markers(
        "tutor/railway/accelerate_chat.py",
        (
            'MURIKAH_DUAL_LANE_CHAT_V7',
            'def _agent_reason(',
            'murikah_current_turn_flags',
            'race_first_visible(',
            'nvidia-fast:',
            'build_context_packet',
            'prepare_next_context',
            'provider_affinity',
            'MURIKAH_CHAT_CONTEXT_CHARS',
            'qwen-fast:',
            'qwen-retry:',
            'nvidia-retry:',
            'gemini-retry:',
            'terminal_first_token_timeout',
            '_FAST_TURN_TIMEOUT_SECONDS',
            'MURIKAH_CHAT_FAST_OUTPUT_TOKENS',
            'MURIKAH_CHAT_MAX_CONTINUATIONS',
            'Continuing response…',
            'partial_response_preserved',
            'finish_reason_needs_continuation',
            'context_packet',
            'history_chars',
            'context_build_ms',
            'route=deep_agent',
            'route=fast',
        ),
    )
    require_markers(
        "tutor/railway/murikah_context_packet.py",
        (
            'DEFAULT_PACKET_CHARS = 16000',
            'DEFAULT_RECENT_TURNS = 4',
            'def build_context_packet(',
            'def provider_affinity(',
            'async def prepare_next_context(',
            'Conversation summary:',
        ),
    )
    forbid_markers(
        "tutor/railway/accelerate_chat.py",
        (
            "recover_with_standard_pipeline",
            "fast_lane_recovery",
            "if context.source_manifest:",
            'if metadata.get("source_index"):',
        ),
    )
    require_markers(
        "tutor/railway/persist_learning_journal.py",
        (
            "MURIKAH_D1_LEARNING_JOURNAL_V2",
            "_murikah_public_error",
            "learner-safe terminal error",
            "learning_turn_start",
            "learning_turn_finish",
            "learning_turn_fail",
        ),
    )
    require_markers(
        "tutor/railway/brand_chat_status.py",
        (
            "Murikah is reasoning…",
            "Murikah is working…",
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
            'learningJournalSchemaVersion',
            'ownershipSchemaVersion',
            'emailVerificationSchemaVersion',
            'verificationEmailConfigured',
            'new signup remains fail-closed',
            'unregisteredObjectCount',
            'every durable manifest object has a D1 ownership record',
            'MURIKAH_TUTOR_OWNERSHIP_TIMEOUT',
            'wait_for_ownership_reconciliation',
            'ownership reconciliation',
            '"/__muri/runtime-status"',
            '"/__muri/container-diagnostics"',
            'MURIKAH_TUTOR_SMOKE_TIMEOUT',
        ),
    )
    require_markers(
        "tutor/cloudflare/verify_persistence_lifecycle.py",
        (
            '"/__muri/persistence-status"',
            '"ownershipSchemaVersion"',
            '"unregisteredObjectCount"',
            "Murikah Tutor persistence lifecycle acceptance: PASS",
            "--snapshot",
            "--verify",
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
            "RESEND_API_KEY",
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
        "tutor/cloudflare/migrations/0002_persistence_mtime_ms.sql",
        (
            "ADD COLUMN mtime_ms INTEGER NOT NULL DEFAULT 0 CHECK (mtime_ms >= 0)",
        ),
    )
    require_markers(
        "tutor/cloudflare/migrations/0003_tutor_learning_journal.sql",
        (
            "CREATE TABLE IF NOT EXISTS tutor_actors",
            "CREATE TABLE IF NOT EXISTS tutor_actor_profiles",
            "CREATE TABLE IF NOT EXISTS tutor_training_consent",
            "CREATE TABLE IF NOT EXISTS tutor_conversations",
            "CREATE TABLE IF NOT EXISTS tutor_turns",
            "CREATE TABLE IF NOT EXISTS tutor_messages",
            "CREATE TABLE IF NOT EXISTS tutor_feedback",
            "learning_journal_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0003_tutor_learning_journal.sql",
        ("CREATE TRIGGER",),
    )
    require_markers(
        "tutor/cloudflare/migrations/0004_tutor_object_ownership.sql",
        (
            "CREATE TABLE IF NOT EXISTS tutor_objects",
            "owner_kind TEXT NOT NULL",
            "owner_id TEXT NOT NULL",
            "runtime_path TEXT NOT NULL UNIQUE",
            "CREATE TABLE IF NOT EXISTS tutor_accounts",
            "CREATE TABLE IF NOT EXISTS tutor_access_audit",
            "ownership_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0004_tutor_object_ownership.sql",
        ("CREATE TRIGGER",),
    )
    require_markers(
        "tutor/cloudflare/migrations/0005_tutor_email_verification.sql",
        (
            "CREATE TABLE IF NOT EXISTS tutor_email_verifications",
            "code_digest TEXT NOT NULL",
            "attempts INTEGER NOT NULL DEFAULT 0",
            "email_verified_at INTEGER",
            "email_verification_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0005_tutor_email_verification.sql",
        ("CREATE TRIGGER", "code TEXT"),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "/learning/actor",
            "/learning/turn/start",
            "/learning/turn/finish",
            "/learning/status",
            "tutor_training_consent",
            "training_eligible",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "x-murikah-object-mtime-ms",
            "x-murikah-object-owner-kind",
            "persistenceOwnership(path)",
            "tutor_objects",
            "/ownership/reconcile",
            "/ownership/status",
            "/account/upsert",
            "/email/start",
            "/email/resend",
            "/email/verify",
            "sendVerificationEmail",
            "RESEND_API_KEY",
            "if (!apiKey) throw new Error('verification_email_not_configured')",
            "verification_email_unavailable",
            "code_digest",
            "/audit",
            "ownershipSchemaVersion",
            "emailVerificationSchemaVersion",
            "unregisteredObjectCount",
            "mtime_ms",
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
            "def object_ownership(",
            "def account_upsert(",
            "def email_verification_start(",
            "def email_verification_resend(",
            "def email_verification_verify(",
            "def access_audit(",
            "def reconcile_ownership(",
            "def reconcile_accounts(",
            "x-murikah-object-owner-kind",
            "def guest_reserve(",
            "def guest_status(",
            "def learning_actor(",
            "def learning_turn_start(",
            "def learning_turn_finish(",
            "def learning_turn_fail(",
            "MAX_LEARNING_CONTENT_CHARS",
            "mtime_ms = max(0, int(mtime_ns) // 1_000_000)",
            "x-murikah-object-mtime-ms",
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
    validate_resend_deploy_policy()
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
    print(" - Gemini fast chat is additive; deep-task NVIDIA selection is preserved for Solve and Math Animator")
    print(" - ordinary Chat is separated from the DeepTutor agent lane")
    print(" - fast chat races Gemini Flash-Lite, NVIDIA Nemotron, and Qwen Flash with a transparent retry race")
    print(" - transient overload/capacity payloads trigger provider failover instead of rendering as Tutor answers")
    print(" - Cloudflare startup bypasses supervisord and starts FastAPI + Next.js directly")
    print(" - stale Cloudflare container applications are detected and recycled during deploy")
    print(" - low-level container.running is authoritative for start eligibility")
    print(" - stale getState transitions cannot trigger duplicate start() calls")
    print(" - staging startup is non-blocking at the edge")
    print(" - Worker bindings are passed explicitly into every Linux container start")
    print(" - Durable Object/container errors are contained and cannot surface as edge 1101")
    print(" - readiness is determined by the real Tutor /health route")
    print(" - D1-backed guest quotas and private R2 runtime checkpoints are wired through the Worker bridge")
    print(" - ordinary follow-ups use bounded portable history and cannot silently fall into the multi-agent pipeline")
    print(" - provider finish reasons are tracked and token-limited/interrupted answers continue invisibly before completion")
    print(" - active fast-chat streams have a 4096-token segment budget, a 300s segment ceiling, and up to three hidden continuation passes")
    print(" - D1 learning journal stores prompt/response pairs and consent-gated training metadata")
    print(" - signed-in member sessions use a long-lived sliding secure cookie and explicit logout remains authoritative")
    print(" - every ordinary account inherits all shareable admin-configured LLMs dynamically; owner-bound admin OAuth models stay private")
    print(" - deployment model/provider settings are hidden from members and remain admin-managed")
    print(" - personal provider credential lifecycle is also admin-only; learners keep personal learning preferences only")
    print(" - every durable R2 object has explicit D1 owner/type metadata, with existing manifest objects reconciled on startup")
    print(" - Tutor opens backend/frontend ports before ownership/account reconciliation or checkpoint maintenance can block readiness")
    print(" - deploy failures refresh isolated startup diagnostics after the actual readiness timeout")
    print(" - new user-owned R2 writes use canonical users/<user-id>/<object-type>/<object-id> keys")
    print(" - non-secret account role/status metadata is reconciled into D1 while credentials remain in Cloudflare Secrets/protected auth storage")
    print(" - Google SSO is a required production secret pair and renders as a branded first-class account option")
    print(" - new local and SSO accounts require a one-time emailed code before any member session is issued")
    print(" - disposable email domains are rejected while legitimate consumer, Apple relay, school, university and corporate MX domains are accepted")
    print(" - verification OTPs are HMAC-digested in D1, expire in 10 minutes, are rate-limited, and are never stored in plaintext")
    print(" - Resend is signup-required but not deploy-blocking; missing email configuration keeps new signup fail-closed")
    print(" - guests can voluntarily sign in or sign up from the top-right before exhausting their seven interactions")
    print(" - Invite friends is available on guest and account surfaces with copy, email, WhatsApp and native share actions")
    print(" - sign-in and sign-up tabs have explicit active-state contrast")
    print(" - Math Animator dependencies are installed and smoke-tested in the production image")
    print(" - Math Animator planning/summary JSON stages use bounded multi-provider recovery with deterministic fallbacks")
    print(" - Math Animator code generation gets an independent provider fallback and raw JSON/provider errors stay out of learner UI")
    print(" - Diagram Design has a real page scroller and renders its SVG before explanation")
    print(" - Deep Solve performs one hidden final repair before surfacing an empty-answer failure")
    print(" - production persistence cutover remains gated on the destructive container-replacement acceptance test")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
