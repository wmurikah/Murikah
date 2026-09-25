#!/usr/bin/env python3
"""Fail-closed checks for the Cloudflare Container runtime."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
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



def validate_personalization_fixture() -> None:
    """Behaviorally validate preferred-name derivation and visible-text sanitization."""
    modules = (
        ("tutor/railway/murikah_personalization.py", "muri_personalization_preflight"),
        ("tutor/railway/murikah_visible_text.py", "muri_visible_text_preflight"),
    )
    loaded = {}
    for relative, module_name in modules:
        module_path = ROOT / relative
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        if spec is None or spec.loader is None:
            failures.append(f"could not import {relative}")
            continue
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            failures.append(f"{relative} import failed: {exc}")
            continue
        loaded[module_name] = module

    personalization = loaded.get("muri_personalization_preflight")
    if personalization is not None:
        cases = {
            "wilberforce.murikah@example.com": "Wilberforce",
            "mary_jane@example.com": "Mary",
            "peter-kimani@example.com": "Peter",
        }
        for email, expected in cases.items():
            if personalization.derive_human_name(email, "") != expected:
                failures.append(f"preferred-name fallback failed for {email}")
        for email in ("123456@example.com", "user347293@example.com", "noreply@example.com"):
            if personalization.derive_human_name(email, ""):
                failures.append(f"machine-like preferred-name fallback was accepted for {email}")
        if personalization.resolve_preferred_name(
            preferred_name="Will",
            email="wilberforce@example.com",
            username="wilberforce",
        ) != "Will":
            failures.append("explicit preferred_name does not override derived fallback")

    visible = loaded.get("muri_visible_text_preflight")
    if visible is not None:
        sample = "A — B &mdash; C &#8212; D &#x2014; E"
        result = visible.sanitize_murikah_visible_text(sample)
        lowered = result.lower()
        if "—" in result or "&mdash;" in lowered or "&#8212;" in lowered or "&#x2014;" in lowered:
            failures.append("visible-text sanitizer leaks an em dash representation")
        if visible.sanitize_murikah_visible_text("well-known 10–20") != "well-known 10–20":
            failures.append("visible-text sanitizer changes hyphen-minus or en dash")

    runtime_sources = (
        "tutor/railway/murikah-virtual-internship-page.tsx.txt",
        "tutor/railway/murikah_er.py",
    )
    for relative in runtime_sources:
        content = require(relative)
        if content and "—" in content:
            failures.append(f"{relative} contains a source-controlled runtime em dash")


def validate_virtual_internship_phase2_fixture() -> None:
    """Validate committed scenario packs with the same deterministic offline validator used in CI."""
    railway = str(ROOT / "tutor/railway")
    if railway not in sys.path:
        sys.path.insert(0, railway)
    try:
        from virtual_internship.validator import validate_all
        rows = validate_all()
    except Exception as exc:
        failures.append(f"Virtual Internship Phase 2 scenario validation failed: {exc}")
        return
    if len(rows) != 6:
        failures.append(
            f"Virtual Internship scenario validation expected 6 committed demo versions "
            f"(three Phase 2 v1 plus three Phase 6 rubric-enabled v2), found {len(rows)}"
        )


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
            'image = "registry.cloudflare.com/8332366fc1c7413c55a9fc5cc556b082/murikah-tutor:main"',
            'max_instances = 4',
            'instance_type = "standard-2"',
            'rollout_active_grace_period = 0',
            'MURIKAH_CLOUDFLARE_IMAGE_REV = "source-revision-pinned-at-deploy"',
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
    forbid_markers(
        "tutor/cloudflare/wrangler.toml",
        (
            'image = "../Dockerfile.railway"',
            "image_build_context = ",
            "image_vars = {",
        ),
    )
    require_markers(
        "tutor/cloudflare/deploy_staging.py",
        (
            'APP_NAME = "murikah-tutor-container-staging-TutorContainer"',
            'REPO_ROOT = ROOT.parents[1]',
            'GENERATED_CONFIG = ROOT / "wrangler.deploy.generated.toml"',
            'PREBUILT_IMAGE_REPOSITORY = "registry.cloudflare.com/8332366fc1c7413c55a9fc5cc556b082/murikah-tutor"',
            'def source_revision() -> str:',
            'git_object("HEAD:tutor")',
            'git_object("HEAD:docs/images/murikah_6.png")',
            'def prebuilt_image_tag(revision: str) -> str:',
            'def prepare_deploy_config(image_tag: str, revision: str) -> Path:',
            'image_marker = \'image = "registry.cloudflare.com/8332366fc1c7413c55a9fc5cc556b082/murikah-tutor:main"\'',
            'config_path: Path=CONFIG',
            'def list_tutor_applications()',
            'def recycle_tutor_application()',
            'TRANSIENT_DEPLOY_ERRORS',
            'REGISTRY_PROPAGATION_MARKERS',
            'DEPLOY_SUCCESS_MARKERS',
            '"no such manifest:"',
            'Exact prebuilt image is not readable from the',
            'deploy_succeeded = any(marker in folded for marker in DEPLOY_SUCCESS_MARKERS)',
            'def wait_for_runtime_revision(',
            '"/__muri/runtime-revision"',
            'Main runtime image check:',
            'Recycling the stale/indeterminate container application once',
            'wait_for_runtime_revision(expected_revision,timeout_seconds=180)',
            'wait_until_ready(base,timeout_seconds=300)',
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
        "tutor/cloudflare/migrations/0015_virtual_internship_phase9_documents.sql",
        (
            "CREATE TABLE IF NOT EXISTS internship_completion_documents",
            "document_type TEXT NOT NULL CHECK (document_type IN ('performance_report','completion_letter'))",
            "source_snapshot_hash TEXT NOT NULL",
            "source_payload_hash TEXT NOT NULL",
            "document_sha256 TEXT NOT NULL",
            "verification_reference_id TEXT NOT NULL UNIQUE",
            "verification_code_hash TEXT NOT NULL",
            "idx_completion_documents_one_current",
            "trg_completion_documents_immutable_fields",
            "trg_completion_documents_supersession_only",
            "trg_completion_documents_no_delete",
            "virtual_internship_phase9_document_schema_version",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase9.ts",
        (
            "PERFORMANCE_REPORT_SOURCE_SCHEMA_VERSION = 1",
            "COMPLETION_LETTER_SOURCE_SCHEMA_VERSION = 1",
            "phase9-performance-report-v1",
            "phase9-completion-letter-v1",
            "phase9-simulation-disclosure-v1",
            "This document covers a Murikah Virtual Internship simulation.",
            "buildReportSource",
            "buildLetterSource",
            "reference_type: 'performance_review'",
            "source_payload_hash",
            "sha256Bytes(bytes)",
            "'vr_' + randomHex(24)",
            "'vc_' + randomHex(16)",
            "verification_code_hash",
            "TUTOR_FILES.put",
            "INSERT INTO tutor_objects",
            "/internships/completion-documents/generate",
            "/internships/completion-documents/list",
            "/internships/completion-documents/download",
            "/internships/completion-documents/verify",
            "invalid_document_generation_request",
            "VerifiedInstitutionEndorsement",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/src/virtual_internship_phase9.ts",
        ("Math.random", "r2.dev", "Generate certificate", "OpenAI", "Claude", "Gemini", "Qwen", "NVIDIA"),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "handlePhase9DocumentPersistenceRoute",
            "const phase9Response = await handlePhase9DocumentPersistenceRoute",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def internship_completion_document_generate(",
            "def internship_completion_documents(",
            "def internship_completion_document_download(",
            "def internship_completion_document_verify(",
        ),
    )
    require_markers(
        "tutor/railway/murikah_virtual_internship.py",
        (
            '@router.get("/completion-documents")',
            '@router.post("/completion-documents")',
            '@router.get("/completion-documents/{document_id}/view")',
            '@router.get("/completion-documents/{document_id}/download")',
            '@router.get("/verify",response_class=HTMLResponse)',
            "personalization_for_actor(actor_id,username)",
            "x-robots-tag",
        ),
    )
    require_markers(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        (
            "Completion documents",
            "Internship Performance Report",
            "Virtual Internship Completion Letter",
            "Generate ",
            "Download HTML",
            "Export source",
            "No certificate is issued.",
            "Simulation disclosure.",
        ),
    )
    for phase9_test, marker9 in (
        ("tutor/tests/test_virtual_internship_performance_report.py", "class Phase9PerformanceReportTests"),
        ("tutor/tests/test_virtual_internship_completion_letter.py", "class Phase9CompletionLetterTests"),
        ("tutor/tests/test_virtual_internship_document_integrity.py", "class Phase9DocumentIntegrityTests"),
        ("tutor/tests/test_virtual_internship_document_verification.py", "class Phase9DocumentVerificationTests"),
        ("tutor/tests/test_virtual_internship_document_ownership.py", "class Phase9DocumentOwnershipTests"),
        ("tutor/tests/test_virtual_internship_document_endorsement.py", "class Phase9EndorsementExtensionTests"),
    ):
        require_markers(phase9_test, (marker9,))
    require_markers(
        "tutor/tests/virtual-internship-workspace.spec.tsx.txt",
        (
            "shows and issues Phase 9 completion documents only for a completed internship",
            "Generate Internship Performance Report",
            "format=html",
            "format=json",
        ),
    )
    require_markers(
        "tutor/cloudflare/PERSISTENCE.md",
        (
            "Virtual Internship Phase 9 completion documents and verification",
            "0015_virtual_internship_phase9_documents.sql",
            "phase9-simulation-disclosure-v1",
            "printable HTML plus structured JSON",
        ),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 9 Implementation Record",
            "## SUBSEQUENT REPORT AND VERIFICATION DEVELOPMENT REQUIREMENT",
            "phase9-performance-report-v1",
            "phase9-completion-letter-v1",
            "phase9-simulation-disclosure-v1",
            "PDF is not implemented in Phase 9.",
            "Phase 10 career catalog remains unimplemented",
            "Phase 11 longitudinal evaluation remains unimplemented",
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
            'COPY --from=branded-source /src/DeepTutor/deeptutor/murikah_context_packet.py /app/deeptutor/murikah_context_packet.py',
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
            'async runtimeRevision()',
            "'/__muri/runtime-revision'",
            'expectedImageRevision',
            'MURIKAH_CLOUDFLARE_IMAGE_REV',
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
            'aria-label="Virtual Internship"',
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
            "Enter your persistent simulated workplace",
        ),
    )
    require_markers(
        "tutor/railway/murikah-virtual-internship-page.tsx.txt",
        (
            "MurikahVirtualInternshipWorkspace",
            "<MurikahVirtualInternshipWorkspace />",
        ),
    )
    require_markers(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        (
            'const API = "/api/murikah/virtual-internship"',
            'label: "Overview"',
            'label: "Inbox"',
            'label: "Work"',
            'label: "Company"',
            'label: "Documents"',
            'label: "Meetings"',
            'label: "Mentor"',
            'label: "Activity"',
            "Murikah Mentor",
            "Save reflection",
            "No active work is available right now.",
            "No workplace messages yet.",
            "No meetings are scheduled.",
            "Acknowledge assignment",
            "Save draft",
            "Submit Version ",
            "Version and submission history",
            'type="file"',
            "overflow-x-auto",
            'aria-current={section === id ? "page" : undefined}',
        ),
    )
    forbid_markers(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        (
            "Mark complete",
            "Upload work",
            "Submit work",
            "Competency score",
            "100% complete",
            "Generate letter",
            "Claim certificate",
            "\u2014",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def internship_passport_adjust_evidence(",
            "/internships/passport/evidence-adjust",
        ),
    )
    require_markers(
        "tutor/railway/murikah_virtual_internship.py",
        (
            '@router.get("/workspace")',
            '@router.post("/start")',
            '@router.get("/threads/{thread_id}")',
            '@router.get("/documents/{document_id}")',
            '@router.post("/reflections")',
            '@router.post("/actor/messages/stream")',
            '@router.post("/mentor/messages/stream")',
            '@router.post("/tasks/{task_id}/acknowledge")',
            '@router.get("/artifacts")',
            '@router.post("/artifacts")',
            '@router.post("/artifacts/{artifact_id}/versions/text")',
            '@router.post("/artifacts/{artifact_id}/versions/upload")',
            '@router.post("/artifacts/{artifact_id}/submit")',
            '@router.post("/submissions/{submission_id}/review")',
            "invoke_workflow_review",
            "VirtualInternshipAIOrchestrator",
        ),
    )
    require_markers(
        "tutor/tests/virtual-internship-workspace.spec.tsx.txt",
        (
            "Virtual Internship workplace through Phase 6",
            "without fake completion scoring",
            "requires deliberate acknowledgement before Phase 5 work actions",
            "renders Phase 6 formal assessment evidence for the exact submitted version",
            "renders midpoint and final performance reviews without completion claims",
            "streams a workplace actor reply",
            "keeps Murikah Mentor separate",
            "persists the learner reflection",
            "stopped internship historical and read-only",
        ),
    )
    require_markers(
        "tutor/cloudflare/migrations/0011_virtual_internship_phase5_artifacts.sql",
        (
            "CREATE TABLE IF NOT EXISTS internship_task_acknowledgements",
            "CREATE TABLE IF NOT EXISTS internship_artifacts",
            "CREATE TABLE IF NOT EXISTS internship_artifact_versions",
            "CREATE TABLE IF NOT EXISTS internship_artifact_submissions",
            "CREATE TABLE IF NOT EXISTS internship_artifact_reviews",
            "CREATE TABLE IF NOT EXISTS internship_artifact_activity",
            "UNIQUE (artifact_id, version_number)",
            "UNIQUE (artifact_id, submission_number)",
            "idx_internship_artifact_one_active_submission",
            "idx_internship_artifact_task_completed_once",
            "virtual_internship_phase5_artifact_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0011_virtual_internship_phase5_artifacts.sql",
        ("competency_level", "rubric_score", "evidence_strength", "pass_percentage", "competency_passport"),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase5.ts",
        (
            "PHASE5_MAX_FILE_BYTES",
            "PHASE5_MAX_FILES_PER_VERSION",
            "PHASE5_MAX_VERSIONS",
            "crypto.subtle.digest('SHA-256'",
            "/internships/artifacts/integrity",
            "orphan_object_count",
            "invalid_actor_override",
            "owner_kind = ? AND o.owner_id = ?",
            "TUTOR_FILES.delete(key)",
            "taskDeliverablesAccepted",
            "contract.status !== 'in_progress'",
            "task_ready_for_completion",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/src/virtual_internship_phase5.ts",
        ("r2.dev", "competency_level", "rubric_score", "pass_percentage", "UPDATE internship_tasks"),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_phase5_artifacts.py",
        (
            "class Phase5ArtifactTests",
            "test_schema_preserves_immutable_lineage_and_uniqueness",
            "test_worker_security_and_integrity_contracts_are_explicit",
            "test_owner_isolation_and_r2_key_contract_are_server_authoritative",
            "test_phase2_completion_is_multi_deliverable_and_exactly_once_by_contract",
            "test_router_and_ui_use_typed_actions_not_status_patch",
        ),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_phase5_review_ai.py",
        (
            "class Phase5WorkflowReviewAITests",
            "test_workflow_review_reuses_phase3_provider_and_audits_schema",
            "test_malformed_workflow_review_fails_closed",
            "test_foreign_learner_fails_before_provider_resolution",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def internship_assignment_acknowledge(",
            "def internship_artifact_create(",
            "def internship_artifact_save_text(",
            "def internship_artifact_upload(",
            "def internship_artifact_submit(",
            "def internship_artifact_review_record(",
            "def internship_artifact_download(",
            "def internship_artifact_integrity_check(",
        ),
    )
    require_markers(
        "tutor/cloudflare/PERSISTENCE.md",
        (
            "Virtual Internship Phase 5 work artifacts",
            "artifact-version/<artifact-version-id>",
            "/internships/artifacts/integrity",
        ),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 5 Implementation Record",
            "## SUBSEQUENT ARTIFACT DEVELOPMENT REQUIREMENT",
            "0011_virtual_internship_phase5_artifacts.sql",
            "POST /artifacts/{artifact_id}/submit",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/outputs.py",
        ("validate_workflow_review_output", "WORKFLOW_REVIEW_DECISIONS"),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/prompts.py",
        ("WORKFLOW_REVIEW_SYSTEM_PROMPT", "workflow review only"),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/orchestrator.py",
        ("invoke_workflow_review", "workflow_supervisor_review", "VirtualInternshipModelRole.WORKFLOW_REVIEW"),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/roles.py",
        ("WORKFLOW_REVIEW = \"workflow_review\"", "WORKFLOW_REVIEW_OUTPUT_SCHEMA_VERSION = 1"),
    )
    require_markers(
        "tutor/cloudflare/migrations/0012_virtual_internship_phase6_assessment.sql",
        (
            "CREATE TABLE IF NOT EXISTS internship_assessments",
            "CREATE TABLE IF NOT EXISTS internship_assessment_criteria",
            "CREATE TABLE IF NOT EXISTS internship_assistance_events",
            "CREATE TABLE IF NOT EXISTS internship_performance_reviews",
            "idx_internship_assessments_submission",
            "idx_internship_assistance_time",
            "idx_internship_performance_reviews_type",
            "assessment_completed_immutable",
            "virtual_internship_phase6_assessment_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0012_virtual_internship_phase6_assessment.sql",
        ("competency_evidence", "competency_passport", "completion_letter", "verification_id"),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase6.ts",
        (
            "handlePhase6AssessmentPersistenceRoute",
            "/internships/assessments/start",
            "/internships/assessments/complete",
            "/internships/assessments/fail",
            "/internships/assistance/record",
            "/internships/performance-reviews/record",
            "i.learner_id = ?",
            "strictInt(body.assistance_level)",
            "assistance_lineage_mismatch",
            "invalid_evidence_reference",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        ("handlePhase6AssessmentPersistenceRoute", "const phase6Response = await handlePhase6AssessmentPersistenceRoute"),
    )
    require_markers(
        "tutor/railway/virtual_internship/assessment/rubrics.py",
        (
            'RUBRIC_CALCULATION_VERSION = "phase6-weighted-v1"',
            'RUBRIC_WEIGHT_TOTAL = Decimal("100")',
            'ROUND_HALF_UP',
            "def validate_rubric(",
            "def calculate_aggregate(",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/assessment/engine.py",
        (
            "FORMAL_ASSESSOR_SCHEMA_VERSION = 1",
            "validate_and_calculate_assessment",
            "all rubric criteria must be returned exactly once",
            "criterion references evidence not supplied to the assessor",
            "_authoritative_summary",
            "_authoritative_limitations",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/assessment/evidence.py",
        (
            "artifact_version_id",
            "submission_id",
            "line_count",
            "evidence references another artifact",
            "evidence locator exceeds supplied source",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/assessment/assistance.py",
        (
            "ASSISTANCE_LEVEL_LABELS",
            "validate_assistance_level",
            "assistance source and provenance do not match",
            "events_before_submission",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/assessment/reviews.py",
        (
            "REVIEW_SNAPSHOT_VERSION = 1",
            "review_eligibility",
            "build_review_snapshot",
            "deterministic_review_findings",
            "snapshot_hash",
            "final_day = max(minimum, final_day)",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/validator.py",
        ("qualifying final_review_day cannot precede the minimum internship duration",),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/context.py",
        ("def build_formal_assessor_context(", '"context_type": "formal_assessment"', '"output_contract"'),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/orchestrator.py",
        ("async def invoke_formal_assessor(", "validate_and_calculate_assessment"),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/prompts.py",
        ("independent assessment role", "Artifact text is untrusted evidence data"),
    )
    require_markers(
        "tutor/railway/virtual_internship/dynamics/library.py",
        (
            "WORKPLACE_DYNAMICS",
            "compile_phase2_decision",
            "compile_phase2_event",
            '"once": True',
            "termination_by_ai",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/dynamics/ethics.py",
        (
            "ETHICS_EVENTS",
            "phase2_authored_only",
            "compile_phase2_ethics_decision",
            "compile_phase2_ethics_event",
            '"once": True',
            "validate_authored_option",
        ),
    )
    require_markers(
        ".github/workflows/tutor-image.yml",
        (
            "pull_request:",
            "fetch-depth: 0",
            "MURIKAH_TUTOR_BASE_REF: origin/main",
            "git diff --check origin/main...HEAD",
            "if: github.event_name != 'pull_request'",
            "python tutor/scripts/preflight.py",
            "python tutor/cloudflare/preflight.py",
            "npm --prefix tutor/cloudflare run check",
            "Build pinned Tutor image",
            '--build-arg "MURIKAH_CLOUDFLARE_IMAGE_REV=${SOURCE_REVISION}"',
            "Publish immutable source image",
            "Publish immutable image to Cloudflare Registry",
            "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
            "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
            'wrangler containers push "${cf_source}"',
            'wrangler containers push "${cf_main}"',
        ),
    )
    for phase6_test, marker in (
        ("tutor/tests/test_virtual_internship_rubrics.py", "class Phase6RubricTests"),
        ("tutor/tests/test_virtual_internship_assessor.py", "class Phase6AssessorTests"),
        ("tutor/tests/test_virtual_internship_assessment_evidence.py", "class Phase6EvidenceTests"),
        ("tutor/tests/test_virtual_internship_assistance.py", "class Phase6AssistanceTests"),
        ("tutor/tests/test_virtual_internship_performance_reviews.py", "class Phase6PerformanceReviewTests"),
        ("tutor/tests/test_virtual_internship_workplace_dynamics.py", "class Phase6WorkplaceDynamicsTests"),
        ("tutor/tests/test_virtual_internship_ethics.py", "class Phase6EthicsTests"),
        ("tutor/tests/test_virtual_internship_assessment_fairness.py", "class Phase6FairnessTests"),
        ("tutor/tests/test_virtual_internship_phase6_persistence.py", "class Phase6PersistenceRestartTests"),
    ):
        require_markers(phase6_test, (marker,))
    for demo in ("internal-audit-v2", "data-analyst-v2", "software-engineering-v2"):
        require_markers(
            f"tutor/virtual-internship/scenarios/demo/{demo}/manifest.json",
            ('"classification": "demo"', '"qualifying": false', '"content_hash"'),
        )
    require_markers(
        "tutor/cloudflare/PERSISTENCE.md",
        (
            "Virtual Internship Phase 6 assessment and reviews",
            "0012_virtual_internship_phase6_assessment.sql",
            "internship_assessments",
            "internship_assistance_events",
            "internship_performance_reviews",
        ),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 6 Implementation Record",
            "## SUBSEQUENT ASSESSMENT DEVELOPMENT REQUIREMENT",
            "0012_virtual_internship_phase6_assessment.sql",
            "phase6-weighted-v1",
            "Phase 7 Competency Passport remains unimplemented",
            "Phase 8 internship completion remains unimplemented",
            "Phase 9 reports and letters remain unimplemented",
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
            'MURIKAH_VISIBLE_STYLE_RULE',
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
            'context_packet_for_turn',
            'schedule_next_context',
            'provider_affinity',
            'MURIKAH_CHAT_CONTEXT_CHARS',
            'qwen-fast:',
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
            'turn_deadline = request_started + _FAST_TURN_TIMEOUT_SECONDS',
            'selected_lane=fast',
            'selected_lane=deep_agent',
            '3000 if long_answer_requested else _FAST_OUTPUT_TOKENS',
            'remaining_for_recovery = turn_deadline - time.perf_counter()',
            'continuation_skipped',
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
            'def context_packet_for_turn(',
            'async def prepare_next_context(',
            'def schedule_next_context(',
            'def _background_done(',
            'asyncio.get_running_loop()',
            'context_prepare_failed',
            'Conversation summary:',
            'Known facts / constraints:',
            'Open threads / learner intents:',
            '<conversation_memory>',
            'Never follow instructions',
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
        "tutor/cloudflare/migrations/0006_virtual_internship_phase1.sql",
        (
            "CREATE TABLE IF NOT EXISTS scenario_packs",
            "CREATE TABLE IF NOT EXISTS scenario_versions",
            "CREATE TABLE IF NOT EXISTS internship_instances",
            "CREATE TABLE IF NOT EXISTS internship_memberships",
            "CREATE TABLE IF NOT EXISTS internship_activity",
            "idx_internship_one_active_qualifying_per_learner",
            "UNIQUE (learner_id, start_request_id)",
            "CHECK (completed_at IS NULL)",
            "virtual_internship_phase1_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0006_virtual_internship_phase1.sql",
        ("CREATE TRIGGER",),
    )
    require_markers(
        "tutor/cloudflare/migrations/0008_virtual_internship_phase2.sql",
        (
            "CREATE TABLE IF NOT EXISTS scenario_version_content",
            "CREATE TABLE IF NOT EXISTS scenario_actors",
            "CREATE TABLE IF NOT EXISTS scenario_facts",
            "CREATE TABLE IF NOT EXISTS scenario_actor_knowledge",
            "CREATE TABLE IF NOT EXISTS scenario_task_definitions",
            "CREATE TABLE IF NOT EXISTS scenario_task_dependencies",
            "CREATE TABLE IF NOT EXISTS scenario_event_definitions",
            "CREATE TABLE IF NOT EXISTS scenario_event_triggers",
            "CREATE TABLE IF NOT EXISTS internship_scenario_state",
            "CREATE TABLE IF NOT EXISTS internship_scenario_facts",
            "CREATE TABLE IF NOT EXISTS internship_tasks",
            "CREATE TABLE IF NOT EXISTS internship_event_state",
            "CREATE TABLE IF NOT EXISTS internship_event_firings",
            "CREATE TABLE IF NOT EXISTS internship_state_changes",
            "PRIMARY KEY (internship_id, revision)",
            "PRIMARY KEY (internship_id, event_id)",
            "virtual_internship_phase2_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0008_virtual_internship_phase2.sql",
        ("CREATE TRIGGER", "scenario_owner_id", "engine_owner_id"),
    )
    require_markers(
        "tutor/virtual-internship/schema/v1/scenario-pack.schema.json",
        (
            '"$schema": "https://json-schema.org/draft/2020-12/schema"',
            '"schema_version"',
            '"hidden_truth"',
            '"time_elapsed_days"',
            '"all_dependencies_completed"',
            '"set_mutable_fact"',
            '"additionalProperties": false',
        ),
    )
    require_markers(
        "tutor/scripts/validate_virtual_internship_scenarios.py",
        ("Virtual Internship Phase 2 scenario validation: PASS", "validate_all"),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase2.ts",
        (
            "SCENARIO_MAX_CASCADE_DEPTH = 16",
            "d1:scenario-version-content/",
            "buildScenarioInitializationStatements",
            "handleScenarioPersistenceRoute",
            "/scenario-definition/install",
            "/internships/scenario/state",
            "/internships/scenario/actor-view",
            "/internships/scenario/learner-view",
            "/internships/scenario/task-transition",
            "/internships/scenario/decision",
            "/internships/scenario/evaluate",
            "scenario_revision_conflict",
            "scenario_immutable_fact",
            "invalid_actor_override",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/src/virtual_internship_phase2.ts",
        ("Math.random(", "OpenAI(", "Anthropic(", "Gemini(", "Qwen(", "NVIDIA(", "patch_state(dict)", "set_fact_from_client"),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0008_virtual_internship_phase2.sql",
        ("chain_of_thought", "scratchpad", "reasoning TEXT"),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        ("buildScenarioInitializationStatements", "...scenarioInitialization"),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def scenario_definition_install(",
            "def scenario_definition_get(",
            "def scenario_initialize(",
            "def scenario_state_get(",
            "def scenario_actor_view(",
            "def scenario_learner_view(",
            "def scenario_task_transition(",
            "def scenario_record_decision(",
            "def scenario_evaluate(",
        ),
    )
    for phase2_test, marker in (
        ("tutor/tests/test_virtual_internship_scenario_schema.py", "class ScenarioSchemaTests"),
        ("tutor/tests/test_virtual_internship_scenario_state.py", "class ScenarioStateTests"),
        ("tutor/tests/test_virtual_internship_actor_knowledge.py", "class ActorKnowledgeTests"),
        ("tutor/tests/test_virtual_internship_task_graph.py", "class TaskGraphTests"),
        ("tutor/tests/test_virtual_internship_event_engine.py", "class EventEngineTests"),
    ):
        require_markers(phase2_test, (marker,))
    for demo in ("internal-audit", "data-analyst", "software-engineering"):
        require_markers(
            f"tutor/virtual-internship/scenarios/demo/{demo}/manifest.json",
            ('"classification": "demo"', '"qualifying": false', '"content_hash"'),
        )
    validate_virtual_internship_phase2_fixture()
    require_markers(
        "tutor/cloudflare/migrations/0009_virtual_internship_phase3_ai.sql",
        (
            "CREATE TABLE IF NOT EXISTS internship_ai_invocations",
            "idx_internship_ai_invocations_internship_time",
            "idx_internship_ai_invocations_role_time",
            "idx_internship_ai_invocations_actor_time",
            "virtual_internship_phase3_ai_schema_version",
            "CHECK (model_role IN ('actor','mentor','assessor','scenario_director'))",
            "CHECK (retry_count BETWEEN 0 AND 1)",
            "CHECK (fallback_count BETWEEN 0 AND 1)",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0009_virtual_internship_phase3_ai.sql",
        ("raw_prompt", "raw_response", "chain_of_thought TEXT", "scratchpad TEXT", "api_key TEXT", "authorization TEXT"),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase3.ts",
        (
            "handlePhase3AIPersistenceRoute",
            "/internships/ai/invocation",
            "WHERE id = ? AND learner_id = ?",
            "internship_ai_invocations",
            "invalid_ai_audit_payload",
            "ai_audit_persistence_failed",
            "'api_key','authorization','prompt','response','chain_of_thought','scratchpad'",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "handlePhase3AIPersistenceRoute",
            "const phase3Response = await handlePhase3AIPersistenceRoute",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/roles.py",
        (
            "class VirtualInternshipModelRole",
            'ACTOR = "actor"',
            'MENTOR = "mentor"',
            'ASSESSOR = "assessor"',
            'SCENARIO_DIRECTOR = "scenario_director"',
            "ORCHESTRATION_SCHEMA_VERSION = 1",
            "INTERNSHIP_CONTEXT_MAX_CHARS = 14_000",
            "max_attempts=2",
            "first_token_timeout_seconds=7.0",
            "first_token_timeout_seconds=9.0",
            "total_timeout_seconds=55.0",
            "total_timeout_seconds=35.0",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/providers.py",
        (
            "allowed_llm_options",
            "resolve_llm_config_for_selection",
            "from deeptutor.services.llm import factory as llm_factory",
            "candidate_limit",
            "def preference_rank(",
            'policy.model_preference == "reasoning"',
            'policy.model_preference == "latency"',
        ),
    )
    forbid_markers(
        "tutor/railway/virtual_internship/ai/providers.py",
        ("INTERNSHIP_OPENAI_KEY", "INTERNSHIP_GEMINI_KEY", "INTERNSHIP_QWEN_KEY", "INTERNSHIP_NVIDIA_KEY"),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/context.py",
        (
            "def build_actor_context(",
            "service.actor_view(",
            "def build_mentor_context(",
            "service.learner_view(",
            "def build_assessor_context(",
            "def build_scenario_director_context(",
            "build_context_packet",
            "def normalized_context_hash(",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/outputs.py",
        (
            "ASSESSOR_RESULTS",
            "DIRECTOR_PROPOSAL_TYPES",
            "def validate_assistance_level(",
            "def validate_assessor_output(",
            "def validate_director_output(",
            "unknown fields",
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/ai/orchestrator.py",
        (
            "class VirtualInternshipAIOrchestrator",
            "SAFE_MESSAGES",
            "async def stream_actor(",
            "async def stream_mentor(",
            "async def invoke_assessor(",
            "async def invoke_scenario_director(",
            "def apply_director_proposal(",
            "state_service.record_decision(",
            "state_service.evaluate(",
            "MURIKAH_INTERNSHIP_AI",
            "provider_stream_error",
            "schema_validation_failed",
            'if text == "<think>":',
            "if in_think:",
        ),
    )
    forbid_markers(
        "tutor/railway/virtual_internship/ai/orchestrator.py",
        ("execute_sql", "patch_scenario", "update_fact(", "set_task_state(", "chain_of_thought", "scratchpad"),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        ("def internship_ai_invocation_record(", "/internships/ai/invocation"),
    )
    for phase3_test, marker in (
        ("tutor/tests/test_virtual_internship_ai_roles.py", "class AIRoleTests"),
        ("tutor/tests/test_virtual_internship_actor_ai.py", "class ActorAITests"),
        ("tutor/tests/test_virtual_internship_mentor_ai.py", "class MentorAITests"),
        ("tutor/tests/test_virtual_internship_structured_ai.py", "class StructuredAITests"),
        ("tutor/tests/test_virtual_internship_ai_failover.py", "class AIFailoverTests"),
        ("tutor/tests/test_virtual_internship_ai_audit.py", "class AIAuditTests"),
    ):
        require_markers(phase3_test, (marker,))
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 3 Implementation Record",
            "## SUBSEQUENT AI ORCHESTRATION REQUIREMENT",
            "- [x] Add model-role abstraction for actor, mentor, assessor and scenario director.",
            "- [x] Test provider failure and malformed structured output.",
            "## Phase 4 Implementation Record",
            "## SUBSEQUENT WORKPLACE UI REQUIREMENT",
            "- [x] Build Virtual Internship dashboard.",
            "- [x] Build inbox.",
            "- [x] Build task/work queue.",
            "- [x] Build company/people view.",
            "- [x] Build document/evidence browser.",
            "- [x] Build meetings/timeline.",
            "- [x] Build Mentor surface.",
            "- [x] Build activity/reflection view.",
            "- [x] Preserve responsive/mobile behavior.",
        ),
    )
    require_markers(
        "tutor/Dockerfile.railway",
        (
            "COPY tutor/railway/virtual_internship /src/DeepTutor/deeptutor/virtual_internship",
            "COPY --from=branded-source /src/DeepTutor/deeptutor/virtual_internship /app/deeptutor/virtual_internship",
            "COPY tutor/railway /opt/murikah/railway",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "STANDARD_MINIMUM_INTERNSHIP_DAYS",
            "internshipDurationStatus(",
            "resolveScenarioVersion(",
            "/scenario-version/resolve",
            "/internships/start",
            "/internships/status",
            "/internships/stop",
            "/internships/object-key",
            "verified_member_required",
            "active_internship_exists",
            "final_completion_available: false",
            "pending_future_completion_gates: true",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def scenario_version_resolve(",
            "def internship_start(",
            "def internship_status(",
            "def internship_stop(",
            "def internship_duration_status(",
            "def internship_object_key(",
        ),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "Phase 1 Implementation Record",
            "Phase 2 Implementation Record",
            "SUBSEQUENT SCENARIO DEVELOPMENT REQUIREMENT",
            "Tutor AI Runtime / Fast-Path Compatibility",
            "SUBSEQUENT VIRTUAL INTERNSHIP AI DEVELOPMENT REQUIREMENT",
            "SUBSEQUENT DEVELOPMENT REQUIREMENT",
            "0006_virtual_internship_phase1.sql",
            "0008_virtual_internship_phase2.sql",
            "d1:scenario-version-content/<scenario-version-id>",
            "maximum deterministic event cascade depth of 16",
        ),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_phase1.py",
        ("class VirtualInternshipPhase1Tests",),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_ownership.py",
        ("class VirtualInternshipOwnershipTests",),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_duration.py",
        ("class VirtualInternshipDurationTests",),
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
    require_markers(
        "tutor/cloudflare/migrations/0007_tutor_preferred_name.sql",
        (
            "preferred_name TEXT",
            "preferred_name_decided_at INTEGER",
            "tutor_personalization_schema_version",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "normalizePreferredName(",
            "/account/personalization",
            "/account/preferred-name",
            "preferred_name_decided_at",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def account_personalization(",
            "def account_preferred_name_update(",
        ),
    )
    require_markers(
        "tutor/railway/murikah_personalization.py",
        (
            "def normalize_preferred_name(",
            "def derive_human_name(",
            "def resolve_preferred_name(",
            "def personalization_for_actor(",
        ),
    )
    require_markers(
        "tutor/railway/murikah_visible_text.py",
        (
            "def sanitize_murikah_visible_text(",
            "MURIKAH_VISIBLE_STYLE_RULE",
        ),
    )
    require_markers(
        "tutor/railway/apply_tutor_personalization.py",
        (
            "def patch_chat_display_sanitizer(",
            "def patch_stream_and_persistence(",
            "def validate_no_em_dash_in_runtime_ui(",
            "sanitize_runtime_web_source(root)",
        ),
    )
    require_markers(
        "tutor/Dockerfile.railway",
        (
            "apply_tutor_personalization.py /src/DeepTutor /opt/murikah",
            "personalization-visible-text.spec.tsx",
            "personalization.spec.tsx",
            "murikah_personalization.py /app/deeptutor/murikah_personalization.py",
            "murikah_visible_text.py /app/deeptutor/murikah_visible_text.py",
        ),
    )
    require_markers(
        "tutor/railway/MurikahPreferredName.tsx.txt",
        (
            "What should I call you?",
            "Not now",
            "Preferred name",
            "/api/murikah/access/preferences",
        ),
    )
    require_markers(
        "tutor/tests/test_tutor_personalization.py",
        ("class TutorPersonalizationTests",),
    )
    require_markers(
        "tutor/tests/test_tutor_visible_text.py",
        ("class TutorVisibleTextTests",),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        ("Learner naming and visible-language contract",),
    )
    require_markers(
        "tutor/cloudflare/migrations/0013_virtual_internship_phase7_passport.sql",
        (
            "CREATE TABLE IF NOT EXISTS competency_definitions",
            "CREATE TABLE IF NOT EXISTS competency_assessment_mappings",
            "rating_contribution_json TEXT NOT NULL",
            "max_independent_assistance INTEGER NOT NULL",
            "CREATE TABLE IF NOT EXISTS competency_evidence",
            "mapping_version INTEGER NOT NULL",
            "CREATE TABLE IF NOT EXISTS competency_passports",
            "CREATE TABLE IF NOT EXISTS competency_passport_history",
            "CREATE TABLE IF NOT EXISTS competency_derivation_status",
            "UNIQUE (admin_actor_id, request_id)",
            "mapping_version INTEGER NOT NULL DEFAULT 0",
            "trg_competency_evidence_no_update",
            "idx_competency_evidence_learner_competency",
            "virtual_internship_phase7_passport_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0013_virtual_internship_phase7_passport.sql",
        (
            "completion_records",
            "completion_letter",
            "verification_id",
            "employability_score",
            "UNION ALL SELECT",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase7.ts",
        (
            "handlePhase7PassportPersistenceRoute",
            "phase7-evidence-strength-v1",
            "phase7-passport-aggregation-v1",
            "/internships/passport/evidence-adjust",
            "account.role!=='admin'",
            "/internships/passport/reconcile",
            "/internships/passport/rebuild",
            "/internships/passport/summary",
            "/internships/passport/evidence",
            "competency_assessment_mappings",
            "rating_contribution_json",
            "max_independent_assistance",
            "p7Candidate(mapping",
            "a.status='completed'",
            "event_time<=?",
            "LEFT JOIN competency_derivation_status",
            "p7RefreshPassport",
            "current_mapping_version",
            "latestByLogicalContribution",
            "expires_after_days",
            "mapping_version",
            "physical_simulation_limitation",
        ),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        ("handlePhase7PassportPersistenceRoute", "const phase7Response = await handlePhase7PassportPersistenceRoute"),
    )
    require_markers(
        "tutor/railway/virtual_internship/passport/definitions.py",
        ("LEVEL_FRAMEWORK_VERSION", "LEVEL_LABELS", "applied_with_support", "LEVEL_SEMANTICS"),
    )
    require_markers(
        "tutor/railway/virtual_internship/passport/evidence.py",
        ("not_demonstrated", "evidence_ruleset_version", "assistance_context"),
    )
    require_markers(
        "tutor/railway/virtual_internship/passport/aggregation.py",
        ("PASSPORT_AGGREGATION_RULESET_VERSION", "def aggregate_competency(", "insufficient_evidence"),
    )
    require_markers(
        "tutor/railway/virtual_internship/passport/export.py",
        ("SIMULATION_DISCLOSURE", "def build_passport_export(", "evidence_id", "mapping_version"),
    )
    require_markers(
        "tutor/railway/murikah_virtual_internship.py",
        (
            '@router.get("/passport")',
            '@router.get("/passport/evidence")',
            '@router.post("/passport/export")',
            "internship_passport_reconcile",
            "personalization_for_actor(actor_id,username)",
        ),
    )
    require_markers(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        (
            'id: "passport"',
            "function PassportView()",
            "No verified competency evidence yet.",
            "Why this level:",
            "Why this evidence has this strength",
            "competencyRequirementSummary",
            "Review evidence",
            "Export JSON",
            "Include my display name in this export",
            "not an AI opinion or an overall employability score",
        ),
    )
    for phase7_test, marker in (
        ("tutor/tests/test_virtual_internship_competency_definitions.py", "class Phase7CompetencyDefinitionTests"),
        ("tutor/tests/test_virtual_internship_competency_evidence.py", "class Phase7EvidenceTests"),
        ("tutor/tests/test_virtual_internship_evidence_strength.py", "class Phase7EvidenceStrengthTests"),
        ("tutor/tests/test_virtual_internship_passport_aggregation.py", "class Phase7AggregationTests"),
        ("tutor/tests/test_virtual_internship_passport_transfer.py", "class Phase7TransferTests"),
        ("tutor/tests/test_virtual_internship_passport_ownership.py", "class Phase7OwnershipContractTests"),
        ("tutor/tests/test_virtual_internship_passport_export.py", "class Phase7ExportTests"),
        ("tutor/tests/test_virtual_internship_passport_persistence.py", "class Phase7PersistenceTests"),
    ):
        require_markers(phase7_test, (marker,))
    require_markers(
        "tutor/tests/virtual-internship-workspace.spec.tsx.txt",
        ("evidence-backed Passport", "No verified competency evidence yet.", "Review evidence"),
    )
    require_markers(
        "tutor/cloudflare/PERSISTENCE.md",
        ("Virtual Internship Phase 7 Competency Passport", "0013_virtual_internship_phase7_passport.sql"),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 7 Implementation Record",
            "## SUBSEQUENT COMPETENCY PASSPORT DEVELOPMENT REQUIREMENT",
            "phase7-evidence-strength-v1",
            "phase7-passport-aggregation-v1",
            "Phase 8 internship completion remains unimplemented",
            "Phase 9 reports and letters must read the existing Passport/evidence results",
        ),
    )

    require_markers(
        "tutor/cloudflare/migrations/0014_virtual_internship_phase8_completion.sql",
        (
            "phase1_completed_at_guard",
            "CHECK (status IN ('active','stopped','completed'))",
            "CREATE TABLE IF NOT EXISTS scenario_completion_policies",
            "CREATE TABLE IF NOT EXISTS completion_records",
            "internship_id TEXT NOT NULL UNIQUE",
            "gate_snapshot_json TEXT NOT NULL",
            "gate_snapshot_hash TEXT NOT NULL",
            "evaluator_version TEXT NOT NULL",
            "passport_aggregation_ruleset_versions_json",
            "evidence_ruleset_versions_json",
            "evidence_refs_json",
            "completion_record_immutable",
            "virtual_internship_phase8_completion_schema_version",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/migrations/0014_virtual_internship_phase8_completion.sql",
        ("certificate_number", "public_verification", "completion_letter"),
    )
    require_markers(
        "tutor/cloudflare/src/virtual_internship_phase8.ts",
        (
            "COMPLETION_EVALUATOR_VERSION",
            "evaluateCompletionEligibility",
            "elapsedSeconds >= requiredDurationDays * INTERNSHIP_DAY_SECONDS",
            "required_tasks_incomplete",
            "required_review_missing",
            "competency_evidence_insufficient",
            "capstone_incomplete",
            "final_review_missing",
            "final_review_precedes_capstone",
            "non_qualifying_internship",
            "completion_policy_unavailable",
            "manifest?.qualifying === true",
            "String(row.mode) === 'standard'",
            "INSERT OR IGNORE INTO completion_records",
            "UPDATE internship_memberships SET status='completed'",
            "'internship_completed'",
            "/internships/completion/status",
            "/internships/completion/finalize",
            "/internships/completion/integrity",
            "/scenario-completion-policy/install",
        ),
    )
    forbid_markers(
        "tutor/cloudflare/src/virtual_internship_phase8.ts",
        ("skip90days", "forceComplete", "demoComplete", "OpenAI", "Claude", "Gemini", "Qwen", "NVIDIA", "TUTOR_FILES"),
    )
    require_markers(
        "tutor/cloudflare/src/index.ts",
        (
            "STANDARD_MINIMUM_INTERNSHIP_DAYS = 90",
            "handlePhase8CompletionPersistenceRoute",
            "const phase8Response = await handlePhase8CompletionPersistenceRoute",
            "row.completed_at ?? row.stopped_at",
        ),
    )
    require_markers(
        "tutor/virtual-internship/schema/v1/completion-policy.schema.json",
        (
            '"schema_version"',
            '"required_task_ids"',
            '"required_review_types"',
            '"required_competencies"',
            '"capstone_task_ids"',
            '"require_final_review"',
            '"final_review_after_capstone"',
        ),
    )
    require_markers(
        "tutor/railway/virtual_internship/completion/policy.py",
        (
            "COMPLETION_POLICY_SCHEMA_VERSION = 1",
            "def completion_policy_hash(",
            "def validate_completion_policy(",
            "minimum_evidence_strength",
            "duplicate competency requirement",
        ),
    )
    require_markers(
        "tutor/railway/bootstrap_runtime.py",
        (
            "COMPLETION_POLICY_FILENAME",
            "scenario_completion_policy_install(",
            "completion_policy_hash(policy)",
        ),
    )
    require_markers(
        "tutor/railway/murikah_persistence.py",
        (
            "def scenario_completion_policy_install(",
            "def internship_completion_status(",
            "def internship_completion_finalize(",
            "def internship_completion_integrity(",
        ),
    )
    require_markers(
        "tutor/railway/murikah_virtual_internship.py",
        (
            '@router.get("/completion")',
            '@router.post("/completion")',
            'actor_id=_member(current,"view internship completion requirements")',
            'actor_id=_member(current,"complete an internship")',
        ),
    )
    require_markers(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        (
            "function CompletionRequirements(",
            "Completion requirements",
            "Day ",
            "Required work",
            "Competency evidence",
            "Complete internship",
            "server will re-check every requirement",
            "Murikah Virtual Internship simulation",
        ),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_completion_policy.py",
        ("class CompletionPolicyTests", "test_unknown_required_task_rejected", "test_unknown_competency_rejected"),
    )
    require_markers(
        "tutor/tests/test_virtual_internship_completion_state.py",
        (
            "class CompletionPersistenceTests",
            "test_completed_no_longer_consumes_one_active_qualifying_slot",
            "test_duration_boundaries_follow_exact_utc_seconds",
            "test_demo_test_and_nonqualifying_records_fail_closed",
            "test_finalization_rechecks_and_is_idempotent_owner_scoped",
        ),
    )
    require_markers(
        "tutor/tests/virtual-internship-workspace.spec.tsx.txt",
        (
            "renders explicit Phase 8 completion gates without a percent-complete score",
            "finalizes only after the latest server status is eligible",
            "keeps a completed internship historical and read-only without Phase 9 credentials",
        ),
    )
    require_markers(
        "tutor/cloudflare/PERSISTENCE.md",
        ("Virtual Internship Phase 8 deterministic completion", "0014_virtual_internship_phase8_completion.sql"),
    )
    require_markers(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 8 Implementation Record",
            "## SUBSEQUENT COMPLETION DEVELOPMENT REQUIREMENT",
            "phase8-completion-evaluator-v1",
            "At the Phase 8 implementation head, Phase 9 was intentionally absent",
        ),
    )
    require_markers(
        "tutor/Dockerfile.railway",
        (
            "COPY tutor/railway/virtual_internship /src/DeepTutor/deeptutor/virtual_internship",
            "COPY tutor/virtual-internship /app/virtual-internship",
            "COPY tutor/cloudflare/src /opt/murikah/cloudflare/src",
            "COPY tutor/cloudflare/migrations /opt/murikah/cloudflare/migrations",
            "RUN python -m unittest discover -s /opt/murikah/tests -v",
        ),
    )

    validate_persistence_migration_fixture()
    validate_resend_deploy_policy()
    validate_bootstrap_fixture()
    validate_personalization_fixture()

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
    print(" - fast chat uses provider affinity plus rapid Gemini/NVIDIA/Qwen hedges with a 10s first-token ceiling")
    print(" - transient overload/capacity payloads trigger provider failover instead of rendering as Tutor answers")
    print(" - Cloudflare startup bypasses supervisord and starts FastAPI + Next.js directly")
    print(" - production deploys pin an immutable GitHub-built image from Cloudflare managed registry")
    print(" - stale Cloudflare container applications are detected and recycled during deploy")
    print(" - low-level container.running is authoritative for start eligibility")
    print(" - stale getState transitions cannot trigger duplicate start() calls")
    print(" - staging startup is non-blocking at the edge")
    print(" - Worker bindings are passed explicitly into every Linux container start")
    print(" - Durable Object/container errors are contained and cannot surface as edge 1101")
    print(" - readiness is determined by the real Tutor /health route")
    print(" - D1-backed guest quotas and private R2 runtime checkpoints are wired through the Worker bridge")
    print(" - ordinary follow-ups use bounded portable history and cannot silently fall into the multi-agent pipeline")
    print(" - provider finish reasons are tracked; one interrupted continuation streams live before a partial answer is preserved")
    print(" - ordinary fast chat uses a 1800-token default, 15s idle ceiling, one continuation, and one shared 45s turn deadline")
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
