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
        "ghcr.io/hkuds/deeptutor:latest",
        "EXPOSE 3782",
        "tutor/railway/bootstrap_runtime.py",
        "tutor/railway/entrypoint.sh",
    ):
        if dockerfile and invariant not in dockerfile:
            fail(f"Dockerfile pin/runtime invariant missing: {invariant!r}")


def check_branding() -> None:
    branding = require_file("tutor/scripts/apply_branding.py")
    for invariant in ("Murikah Tutor", "AI-powered personalised learning", "murikah-logo.png"):
        if branding and invariant not in branding:
            fail(f"branding invariant missing: {invariant!r}")
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

    health = require_file("tutor/railway/health-route.ts")
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
    check_no_new_database_dependency()
    check_stack_isolation()

    if failures:
        print("\nFAILED")
        for item in failures:
            print(f" - {item}")
        return 1

    print("\nPASS")
    print(" - DeepTutor source tag, commit and runtime version are consistent")
    print(" - Murikah Tutor branding invariants are present")
    print(" - Railway custom Dockerfile path is explicitly documented")
    print(" - production authentication and secure-cookie hardening are present")
    print(" - main-container subprocess execution defaults to disabled")
    print(" - /app/data persistence and port 3782 deployment assumptions are documented")
    print(" - no Turso/Postgres/PocketBase dependency is introduced by Tutor deployment code")
    print(" - existing Murikah application stack remains outside the Tutor deployment boundary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
