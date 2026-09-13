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
            'main = "src/index_v2.ts"',
            'workers_dev = true',
            'class_name = "TutorContainer"',
            'image = "../Dockerfile.railway"',
            'image_build_context = "../.."',
            'instance_type = "standard-2"',
            'new_sqlite_classes = ["TutorContainer"]',
            '[secrets]',
            'required = ["MURIKAH_TUTOR_ADMIN_PASSWORD"]',
        ),
    )
    forbid_markers(
        "tutor/cloudflare/wrangler.toml",
        ('pattern = "tutor.murikah.com"', 'custom_domain = true'),
    )
    require_markers(
        "tutor/cloudflare/src/index_v2.ts",
        (
            'extends Container<TutorEnv>',
            'defaultPort = 3782',
            'requiredPorts = [3782]',
            'sleepAfter = "30m"',
            'pingEndpoint = "localhost/__muri/gateway-health"',
            'MURIKAH_EDGE_GATEWAY: "1"',
            'MURIKAH_TUTOR_APP_PORT: "3783"',
            '"murikah-tutor-staging-v5"',
            '"/__muri/runtime-status"',
            '"/__muri/container-diagnostics"',
            '"/__muri/edge-health"',
            'x-murikah-tutor-runtime',
            'MURIKAH_TUTOR_ADMIN_PASSWORD',
            'MURIKAH_GOOGLE_CLIENT_ID',
            'MURIKAH_MICROSOFT_CLIENT_ID',
            'MURIKAH_APPLE_CLIENT_ID',
        ),
    )
    require_markers(
        "tutor/cloudflare/murikah_edge_gateway.js",
        (
            'server.listen(listenPort, listenHost',
            '"/__muri/gateway-health"',
            'server.on("upgrade"',
            'appPort = Number(process.env.MURIKAH_TUTOR_APP_PORT || 3783)',
        ),
    )
    require_markers(
        "tutor/railway/entrypoint.sh",
        (
            'MURIKAH_EDGE_GATEWAY',
            'node /app/murikah-edge-gateway.js',
            'MURIKAH_TUTOR_APP_PORT:=3783',
            'DeepTutor runtime exited with code',
        ),
    )
    require_markers(
        "tutor/railway/bootstrap_runtime.py",
        ('_runtime_port("MURIKAH_TUTOR_APP_PORT", 3782)',),
    )
    require_markers(
        "tutor/Dockerfile.railway",
        ('COPY tutor/cloudflare/murikah_edge_gateway.js /app/murikah-edge-gateway.js',),
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

    if failures:
        print("Murikah Tutor Cloudflare migration preflight: FAILED")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Murikah Tutor Cloudflare migration preflight: PASS")
    print(" - port 3782 is owned by an immediate lightweight gateway")
    print(" - Next.js runs internally on 3783 and FastAPI on 8001")
    print(" - HTTP and WebSocket traffic proxy only after Tutor /health is ready")
    print(" - runtime secrets are passed explicitly into each Linux container start")
    print(" - failed DeepTutor child processes restart behind the live gateway")
    print(" - production tutor.murikah.com remains untouched")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
