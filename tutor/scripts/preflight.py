#!/usr/bin/env python3
"""Fail-closed preflight checks for the isolated Murikah Tutor deployment."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SOURCE_TAG = "v1.6.6"
EXPECTED_RUNTIME_VERSION = "1.6.6"
EXPECTED_COMMIT = "7a96bba1ae03401644c17763a2411c28aff3dcc9"
EXPECTED_UPSTREAM = "https://github.com/HKUDS/DeepTutor.git"
EXPECTED_RAILWAY_DOCKERFILE = "RAILWAY_DOCKERFILE_PATH=/tutor/Dockerfile.railway"

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def require_file(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        fail(f"missing required file: {relative}")
        return ""
    return path.read_text(encoding="utf-8")


def parse_env(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def check_source_pin() -> None:
    env = parse_env(require_file("tutor/source/upstream.env"))
    expected = {
        "DEEPTUTOR_REPOSITORY": EXPECTED_UPSTREAM,
        "DEEPTUTOR_VERSION": EXPECTED_SOURCE_TAG,
        "DEEPTUTOR_COMMIT": EXPECTED_COMMIT,
        "DEEPTUTOR_LICENSE": "Apache-2.0",
    }
    for key, value in expected.items():
        if env.get(key) != value:
            fail(f"source pin mismatch: {key} must be {value!r}, found {env.get(key)!r}")

    dockerfile = require_file("tutor/Dockerfile.railway")
    for invariant in (
        f"ARG DEEPTUTOR_VERSION={EXPECTED_RUNTIME_VERSION}",
        f"ARG DEEPTUTOR_COMMIT={EXPECTED_COMMIT}",
        "ghcr.io/hkuds/deeptutor:${DEEPTUTOR_VERSION}",
        "EXPOSE 3782",
        "tutor/railway/bootstrap_runtime.py",
        "tutor/railway/entrypoint.sh",
    ):
        if dockerfile and invariant not in dockerfile:
            fail(f"Dockerfile pin/runtime invariant missing: {invariant!r}")


def check_branding() -> None:
    branding = require_file("tutor/scripts/apply_branding.py")
    for invariant in (
        "Murikah Tutor",
        "AI-powered personalised learning",
        "murikah-logo.png",
        "#1E2A30",
        "#A9822E",
        "rigorous university-level teaching",
    ):
        if branding and invariant not in branding:
            fail(f"branding/product invariant missing: {invariant!r}")
    if not (ROOT / "docs/images/murikah_6.png").is_file():
        fail("existing Murikah logo asset docs/images/murikah_6.png is missing")


def check_security_and_persistence() -> None:
    bootstrap = require_file("tutor/railway/bootstrap_runtime.py")
    for invariant in (
        '"enabled": True',
        '"cookie_secure": True',
        'current["sandbox_allow_subprocess"] = False',
        'current["frontend_port"] = 3782',
        'current["backend_port"] = 8001',
        'current["backend_workers"] = 1',
        "MURIKAH_TUTOR_ADMIN_PASSWORD",
    ):
        if bootstrap and invariant not in bootstrap:
            fail(f"runtime hardening invariant missing: {invariant!r}")

    entrypoint = require_file("tutor/railway/entrypoint.sh")
    if entrypoint and "murikah-tutor-bootstrap.py" not in entrypoint:
        fail("Tutor entrypoint does not run the production bootstrap")

    health = require_file("tutor/railway/health-route.ts.txt")
    if health and "/health/ready" not in health:
        fail("public Tutor health route does not verify FastAPI readiness")

    railway = require_file("tutor/railway/README.md")
    for invariant in (
        "/app/data",
        "3782",
        "MURIKAH_TUTOR_ADMIN_PASSWORD",
        "/health",
        EXPECTED_RAILWAY_DOCKERFILE,
    ):
        if railway and invariant not in railway:
            fail(f"Railway deployment documentation missing: {invariant!r}")


def check_codespaces_cloudflare_tunnel() -> None:
    tunnel = require_file("tutor/codespaces/cloudflare-tunnel.sh")
    for invariant in (
        "CLOUDFLARE_TUNNEL_TOKEN",
        "cloudflare/cloudflared:latest",
        "murikah-tutor-codespaces",
        "--token-file",
        "chmod 600",
        "stat -c '%u'",
        '--user "$token_uid:$token_gid"',
        ".State.Restarting",
        "--network host",
        'ORIGIN_URL="http://127.0.0.1:3782"',
        "--protocol http2",
        "Registered tunnel connection",
        "origin_is_healthy",
    ):
        if tunnel and invariant not in tunnel:
            fail(f"Codespaces Cloudflare Tunnel invariant missing: {invariant!r}")

    for obsolete in (
        "murikah-tutor-net",
        'TUNNEL_DNS_PRIMARY="1.1.1.1"',
        'TUNNEL_DNS_SECONDARY="1.0.0.1"',
    ):
        if tunnel and obsolete in tunnel:
            fail(f"Codespaces tunnel still contains obsolete bridge-network invariant: {obsolete!r}")

    runbook = require_file("tutor/codespaces/CLOUDFLARE.md")
    for invariant in (
        "tutor.murikah.com",
        "http://127.0.0.1:3782",
        "CLOUDFLARE_TUNNEL_TOKEN",
        "Private",
        "host networking",
        "HTTP/2",
        "7844",
    ):
        if runbook and invariant not in runbook:
            fail(f"Cloudflare Tunnel runbook missing: {invariant!r}")

    codespaces = require_file("tutor/codespaces/README.md")
    for invariant in (
        "host networking",
        "http://127.0.0.1:3782",
        "127.0.0.11",
    ):
        if codespaces and invariant not in codespaces:
            fail(f"Codespaces documentation missing host-network tunnel invariant: {invariant!r}")

    start = require_file("tutor/codespaces/start.sh")
    autostart = require_file("tutor/codespaces/autostart.sh")
    stop = require_file("tutor/codespaces/stop.sh")
    for relative, content in (
        ("start.sh", start),
        ("autostart.sh", autostart),
        ("stop.sh", stop),
    ):
        if content and "cloudflare-tunnel.sh" not in content:
            fail(f"Codespaces {relative} is not wired to cloudflare-tunnel.sh")


def check_wake_worker() -> None:
    worker = require_file("tutor/wake-worker/src/index.js")
    for invariant in (
        "GITHUB_CODESPACES_TOKEN",
        "/user/codespaces/${encodeURIComponent(env.CODESPACE_NAME)}",
        "/start",
        "ORIGIN_HOST",
        "tutor_dormant",
        "sec-fetch-mode",
        "Murikah Tutor is waking up",
        "proxyToTutor",
        "x-murikah-tutor-ingress",
        "/__muri/wake-status",
    ):
        if worker and invariant not in worker:
            fail(f"Tutor wake Worker invariant missing: {invariant!r}")

    wrangler = require_file("tutor/wake-worker/wrangler.toml")
    for invariant in (
        'name = "murikah-tutor-wake"',
        'workers_dev = false',
        'ORIGIN_HOST = "tutor-origin.murikah.com"',
        'CODESPACE_NAME = "glorious-yodel-x7jj5gw954h99vw"',
    ):
        if wrangler and invariant not in wrangler:
            fail(f"Tutor wake Worker configuration missing: {invariant!r}")

    if wrangler:
        for line in wrangler.splitlines():
            if line.strip().startswith("GITHUB_CODESPACES_TOKEN ="):
                fail("GitHub Codespaces token must never be stored in wrangler.toml")

    wake_runbook = require_file("tutor/wake-worker/README.md")
    for invariant in (
        "tutor.murikah.com",
        "tutor-origin.murikah.com",
        "GITHUB_CODESPACES_TOKEN",
        "http://127.0.0.1:3782",
        "Custom Domain",
        "Codespaces lifecycle",
    ):
        if wake_runbook and invariant not in wake_runbook:
            fail(f"Tutor wake Worker runbook missing: {invariant!r}")

    package = require_file("tutor/wake-worker/package.json")
    for invariant in (
        '"murikah-tutor-wake-worker"',
        '"wrangler"',
        '"deploy"',
    ):
        if package and invariant not in package:
            fail(f"Tutor wake Worker package metadata missing: {invariant!r}")


def check_no_new_database_dependency() -> None:
    executable_files = (
        "tutor/Dockerfile.railway",
        "tutor/railway/bootstrap_runtime.py",
        "tutor/railway/entrypoint.sh",
        "tutor/railway/apply_railway_overlay.py",
    )
    prohibited = (
        "import libsql",
        "from libsql",
        "turso://",
        "libsql://",
        "postgresql://",
        "postgres://",
        "pocketbase_url",
        "pocketbase_admin",
    )
    for relative in executable_files:
        content = require_file(relative).lower()
        for token in prohibited:
            if content and token in content:
                fail(f"{relative} unexpectedly introduces database integration signal {token!r}")


def check_stack_isolation() -> None:
    base_ref = os.environ.get("MURIKAH_TUTOR_BASE_REF", "main")
    try:
        verify = subprocess.run(
            ["git", "rev-parse", "--verify", base_ref],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        print("SKIP stack isolation diff: git is not installed")
        return

    if verify.returncode != 0:
        print(f"SKIP stack isolation diff: base ref {base_ref!r} is unavailable")
        return

    diff = subprocess.run(
        ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if diff.returncode != 0:
        fail(f"unable to calculate git diff from {base_ref!r}: {diff.stderr.strip()}")
        return

    changed = [line.strip() for line in diff.stdout.splitlines() if line.strip()]
    outside_tutor = [path for path in changed if not path.startswith("tutor/")]
    if outside_tutor:
        fail("Tutor feature work modifies paths outside tutor/: " + ", ".join(outside_tutor))


def main() -> int:
    print("Murikah Tutor deployment preflight")
    check_source_pin()
    check_branding()
    check_security_and_persistence()
    check_codespaces_cloudflare_tunnel()
    check_wake_worker()
    check_no_new_database_dependency()
    check_stack_isolation()

    if failures:
        print("\nFAILED")
        for item in failures:
            print(f" - {item}")
        return 1

    print("\nPASS")
    print(" - DeepTutor source tag, commit and runtime version are consistent")
    print(" - Murikah Tutor identity, visual tokens and teaching baseline are present")
    print(" - Railway custom Dockerfile path is explicitly documented")
    print(" - production authentication and secure-cookie hardening are present")
    print(" - main-container subprocess execution defaults to disabled")
    print(" - /app/data persistence and port 3782 deployment assumptions are documented")
    print(" - Codespaces named Cloudflare Tunnel uses host networking, protected token access and edge registration checks")
    print(" - Cloudflare wake Worker keeps the public Tutor front door independent from Codespaces uptime")
    print(" - no Turso/Postgres/PocketBase dependency is introduced by Tutor deployment code")
    print(" - existing Murikah application stack remains outside the Tutor deployment boundary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
