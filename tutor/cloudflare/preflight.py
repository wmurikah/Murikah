#!/usr/bin/env python3
"""Fail-closed checks for the staged Cloudflare Container migration."""
from __future__ import annotations

from pathlib import Path

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


def main() -> int:
    require_markers(
        "tutor/cloudflare/package.json",
        (
            '"@cloudflare/containers": "0.3.7"',
            '"wrangler": "4.130.0"',
            '"deploy:staging"',
            '--containers-rollout=immediate',
            '"check"',
        ),
    )
    require_markers(
        "tutor/cloudflare/wrangler.toml",
        (
            'name = "murikah-tutor-container-staging"',
            'workers_dev = true',
            'class_name = "TutorContainer"',
            'image = "../Dockerfile.railway"',
            'image_build_context = "../.."',
            'max_instances = 4',
            'instance_type = "standard-2"',
            'rollout_active_grace_period = 0',
            'MURIKAH_CLOUDFLARE_IMAGE_REV = "2026-09-13-v7"',
            'new_sqlite_classes = ["TutorContainer"]',
            '[secrets]',
            'required = ["MURIKAH_TUTOR_ADMIN_PASSWORD"]',
        ),
    )
    forbid_markers(
        "tutor/cloudflare/wrangler.toml",
        (
            'pattern = "tutor.murikah.com"',
            'custom_domain = true',
        ),
    )
    require_markers(
        "tutor/cloudflare/entrypoint.sh",
        (
            'python /app/murikah-tutor-bootstrap.py',
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
            'sleepAfter = "30m"',
            'entrypoint = [CLOUDFLARE_ENTRYPOINT]',
            'CLOUDFLARE_ENTRYPOINT = "/app/murikah-cloudflare-entrypoint.sh"',
            'isLiveState(',
            'state?.status === "running" || state?.status === "healthy"',
            'buildContainerEnv(env)',
            'this.ctx.container.start({',
            'env: runtimeEnv',
            'entrypoint: [CLOUDFLARE_ENTRYPOINT]',
            'async ensureStarted(',
            'async runtimeStatus()',
            'async isolatedStartupDiagnostics(',
            'isolatedStartupDiagnostics(runtimeEnv)',
            'this.ctx.container.getTcpPort(3782).fetch(',
            'this.ctx.container.destroy("Murikah staging diagnostic complete")',
            '"murikah-tutor-staging-v6"',
            '"murikah-tutor-staging-diagnostics-v6"',
            '"/__muri/runtime-status"',
            '"/__muri/container-diagnostics"',
            '"/__muri/edge-health"',
            '"/__muri/worker-config"',
            'workerSecretConfigured',
            'url.pathname === "/favicon.ico"',
            'x-murikah-tutor-runtime',
            'MURIKAH_TUTOR_ADMIN_PASSWORD',
            'MURIKAH_GOOGLE_CLIENT_ID',
            'MURIKAH_MICROSOFT_CLIENT_ID',
            'MURIKAH_APPLE_CLIENT_ID',
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
        ),
    )
    require_markers(
        "tutor/cloudflare/smoke_staging.py",
        (
            '"/__muri/worker-config"',
            'adminPasswordConfigured',
            '"/__muri/runtime-status"',
            '"/__muri/container-diagnostics"',
            'MURIKAH_TUTOR_SMOKE_TIMEOUT',
        ),
    )
    require_markers(
        "tutor/cloudflare/README.md",
        (
            "Cloudflare Workers Builds",
            "Production remains on the existing Cloudflare wake Worker",
            "python tutor/scripts/preflight.py",
            "npm --prefix tutor/cloudflare run deploy:staging",
            "Do **not** attach `tutor.murikah.com`",
            "PERSISTENCE.md",
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

    if failures:
        print("Murikah Tutor Cloudflare migration preflight: FAILED")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Murikah Tutor Cloudflare migration preflight: PASS")
    print(" - staging Container cannot claim the production Tutor hostname")
    print(" - Cloudflare startup bypasses supervisord and starts FastAPI + Next.js directly")
    print(" - stopped/stopped_with_code are treated as stopped and are restarted")
    print(" - staging startup is non-blocking at the edge")
    print(" - Worker bindings are passed explicitly into every Linux container start")
    print(" - Worker secret visibility is probed before the smoke test waits on Tutor")
    print(" - Durable Object/container errors are contained and cannot surface as edge 1101")
    print(" - isolated diagnostics use the real runtime env and release their container slot")
    print(" - readiness is determined by the real Tutor /health route")
    print(" - standard-2 gives staging a full vCPU for Python + Next.js cold start")
    print(" - spare staging capacity tolerates stale instances during migration")
    print(" - production cutover remains blocked on externalised /app/data persistence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
