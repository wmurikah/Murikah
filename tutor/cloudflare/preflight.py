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
            '"check"',
        ),
    )
    require_markers(
        "tutor/cloudflare/wrangler.toml",
        (
            'name = "murikah-tutor-container-staging"',
            'workers_dev = true',
            '[secrets]',
            'required = ["MURIKAH_TUTOR_ADMIN_PASSWORD"]',
            'class_name = "TutorContainer"',
            'image = "../Dockerfile.railway"',
            'image_build_context = "../.."',
            'max_instances = 2',
            'instance_type = "standard-1"',
            'new_sqlite_classes = ["TutorContainer"]',
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
        "tutor/cloudflare/src/index.ts",
        (
            'extends Container<TutorEnv>',
            'defaultPort = 3782',
            'requiredPorts = [3782]',
            'sleepAfter = "15m"',
            'enableInternet = true',
            'FRONTEND_HOST: "0.0.0.0"',
            'getContainer(env.TUTOR_CONTAINER, "murikah-tutor-staging")',
            '"murikah-tutor-staging-diagnostics-v2"',
            'isolatedStartupDiagnostics',
            'entrypoint: [',
            'this.ctx.container.exec(',
            'this.ctx.container.getTcpPort(3782).fetch(',
            'timeout 8s /app/murikah-tutor-entrypoint.sh',
            'portReadyTimeoutMS: 10_000',
            '"/__muri/container-diagnostics"',
            '"/__muri/edge-health"',
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
            'os.environ',
            'portReadyTimeoutMS: 120_000',
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
    print(" - Cloudflare deploys fail closed unless the first-boot admin secret exists")
    print(" - primary staging Tutor remains a single stable application instance")
    print(" - one extra staging slot is reserved only for isolated startup diagnostics")
    print(" - failed primary startup returns within 10 seconds instead of blocking for two minutes")
    print(" - diagnostics reproduce startup without sharing the primary readiness alarm")
    print(" - production cutover remains blocked on externalised /app/data persistence")
    print(" - Workers Builds deployment contract is documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
