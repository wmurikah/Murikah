#!/usr/bin/env python3
"""Deploy Murikah Tutor and recover from Cloudflare's stale container-app rollout bug.

Cloudflare Containers issue #233 can report a completed rollout while a named
Durable Object keeps receiving the previous application image. We deploy
normally first, verify the image the runtime actually serves, and only if the
old image remains after a propagation window do we recycle the Tutor container
application. Control-plane deletion/recreation is explicitly waited and retried
to avoid transient APPLICATION_NOT_FOUND races.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "wrangler.toml"
APP_NAME = "murikah-tutor-container-staging-TutorContainer"
VERIFY_BASES = (
    "https://murikah-tutor-container-staging.hasspe.workers.dev",
    "https://tutor.murikah.com",
)
APPLICATION_NOT_FOUND = "APPLICATION_NOT_FOUND"


def wrangler_path() -> str:
    local = ROOT / "node_modules" / ".bin" / "wrangler"
    if local.exists():
        return str(local)
    found = shutil.which("wrangler")
    if found:
        return found
    raise RuntimeError("wrangler executable was not found")


def expected_image_revision() -> str:
    text = CONFIG.read_text(encoding="utf-8")
    match = re.search(
        r'MURIKAH_CLOUDFLARE_IMAGE_REV\s*=\s*"([^"]+)"',
        text,
    )
    if not match:
        raise RuntimeError("MURIKAH_CLOUDFLARE_IMAGE_REV is missing from wrangler.toml")
    return match.group(1)


def run_wrangler(*args: str, capture: bool = False) -> subprocess.CompletedProcess[str]:
    command = [wrangler_path(), *args, "--config", str(CONFIG)]
    environment = os.environ.copy()
    # Cloudflare Workers Builds is non-interactive. Make that explicit so a
    # stale-application recycle can never block on a confirmation prompt.
    environment["CI"] = "true"
    return subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def emit_completed_process(result: subprocess.CompletedProcess[str]) -> None:
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(
            result.stderr,
            end="" if result.stderr.endswith("\n") else "\n",
            file=sys.stderr,
        )


def deploy(*, attempts: int = 7) -> None:
    """Deploy, tolerating Cloudflare's transient deleted-application tombstone."""

    delays = (3, 5, 8, 13, 20, 30)
    for attempt in range(1, attempts + 1):
        try:
            result = run_wrangler(
                "deploy",
                "--containers-rollout=immediate",
                capture=True,
            )
            emit_completed_process(result)
            return
        except subprocess.CalledProcessError as exc:
            if exc.stdout:
                print(exc.stdout, end="" if exc.stdout.endswith("\n") else "\n")
            if exc.stderr:
                print(
                    exc.stderr,
                    end="" if exc.stderr.endswith("\n") else "\n",
                    file=sys.stderr,
                )
            combined = f"{exc.stdout or ''}\n{exc.stderr or ''}"
            if APPLICATION_NOT_FOUND not in combined or attempt >= attempts:
                raise
            delay = delays[min(attempt - 1, len(delays) - 1)]
            print(
                "[Murikah Tutor] Cloudflare container application deletion is "
                f"still propagating; retrying deploy in {delay}s "
                f"({attempt}/{attempts})."
            )
            time.sleep(delay)

    raise RuntimeError("Tutor deploy retry loop exhausted unexpectedly")


def parse_json_output(raw: str) -> Any:
    text = raw.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # JSON mode should be clean, but tolerate a Wrangler informational line.
        starts = [pos for pos in (text.find("["), text.find("{")) if pos >= 0]
        if not starts:
            raise
        start = min(starts)
        for end_char in ("]", "}"):
            end = text.rfind(end_char)
            if end >= start:
                try:
                    return json.loads(text[start : end + 1])
                except json.JSONDecodeError:
                    continue
        raise


def list_tutor_applications() -> list[dict[str, Any]]:
    result = run_wrangler("containers", "list", "--json", capture=True)
    applications = parse_json_output(result.stdout)
    if not isinstance(applications, list):
        raise RuntimeError("wrangler containers list did not return a JSON list")
    return [
        app
        for app in applications
        if isinstance(app, dict)
        and str(app.get("name", "")).casefold() == APP_NAME.casefold()
        and app.get("id")
    ]


def wait_for_application_absent(*, timeout_seconds: int = 90) -> None:
    """Wait until Cloudflare's container listing no longer exposes the old app."""

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not list_tutor_applications():
            # The deploy API and dashboard list are not guaranteed to converge
            # at the exact same instant. Give the modify/create path a small
            # grace period; deploy() also retries APPLICATION_NOT_FOUND.
            time.sleep(3)
            return
        time.sleep(3)
    raise RuntimeError(
        f"container application {APP_NAME!r} still exists after {timeout_seconds}s"
    )


def recycle_tutor_application() -> None:
    matches = list_tutor_applications()
    if not matches:
        # A prior failed recovery may already have completed the deletion.
        print(
            "[Murikah Tutor] Stale container application is already absent; "
            "continuing with recreation."
        )
        return

    for app in matches:
        app_id = str(app["id"])
        print(f"[Murikah Tutor] Recycling stale Cloudflare container application {APP_NAME}.")
        run_wrangler("containers", "delete", app_id)

    wait_for_application_absent()


def fetch_json(base: str, path: str, *, timeout: float) -> dict[str, Any]:
    separator = "&" if "?" in path else "?"
    url = f"{base.rstrip('/')}{path}{separator}deploy_check={time.time_ns()}"
    request = Request(
        url,
        headers={
            "accept": "application/json",
            "cache-control": "no-cache",
            "user-agent": "Murikah-Tutor-Deploy-Verification/1.0",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"unexpected JSON payload from {base}{path}")
    return payload


def image_revision(report: dict[str, Any]) -> str:
    image = report.get("image")
    if not isinstance(image, dict):
        return ""
    output = str(image.get("output", ""))
    match = re.search(r"(?m)^image-revision=([^\r\n]+)$", output)
    return match.group(1).strip() if match else ""


def startup_log(report: dict[str, Any]) -> str:
    value = report.get("startupLog")
    return str(value.get("output", "")) if isinstance(value, dict) else ""


def diagnostic_report(
    expected_revision: str,
    *,
    timeout_seconds: int = 90,
) -> tuple[dict[str, Any], str]:
    """Poll until the deployed revision is actually served or the window expires."""

    deadline = time.monotonic() + timeout_seconds
    last_error = ""
    last_report: dict[str, Any] | None = None
    last_base = ""

    while time.monotonic() < deadline:
        for base in VERIFY_BASES:
            try:
                report = fetch_json(base, "/__muri/container-diagnostics", timeout=40)
                revision = image_revision(report)
                print(
                    "[Murikah Tutor] Runtime image check: "
                    f"{revision or 'unknown'} (expected {expected_revision})."
                )
                last_report = report
                last_base = base
                if revision == expected_revision:
                    return report, base
            except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(3)

    if last_report is not None:
        return last_report, last_base
    raise RuntimeError(f"could not obtain Tutor container diagnostics: {last_error}")


def wait_until_ready(base: str, *, timeout_seconds: int = 180) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            last = fetch_json(base, "/__muri/runtime-status", timeout=15)
            if last.get("ready") is True and last.get("httpStatus") == 200:
                return last
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError):
            pass
        time.sleep(3)
    return last


def safe_failure_detail(log: str) -> str:
    blocked = ("password", "secret", "token", "api_key", "client_secret", "private_key")
    safe_lines: list[str] = []
    for line in log.splitlines():
        low = line.lower()
        safe_lines.append("<redacted diagnostic line>" if any(x in low for x in blocked) else line)
    return "\n".join(safe_lines[-24:])


def verify_fresh_runtime(expected_revision: str) -> tuple[bool, dict[str, Any], str]:
    report, base = diagnostic_report(expected_revision)
    return image_revision(report) == expected_revision, report, base


def main() -> int:
    expected_revision = expected_image_revision()

    # Normal deploy first. Healthy rollouts remain non-destructive. deploy()
    # also heals a tombstoned application left by a previous failed recovery.
    deploy()
    fresh, report, base = verify_fresh_runtime(expected_revision)

    if not fresh:
        # Cloudflare containers#233 workaround: remove the stale application,
        # wait for control-plane deletion to converge, then let Wrangler recreate
        # it against the same Durable Object namespace.
        recycle_tutor_application()
        deploy()
        fresh, report, base = verify_fresh_runtime(expected_revision)
        if not fresh:
            raise RuntimeError(
                "Cloudflare still served a stale Tutor image after application recreation"
            )

    log = startup_log(report)
    runtime = report.get("runtime") if isinstance(report.get("runtime"), dict) else {}
    port_probe = str(runtime.get("port3782", "")) if isinstance(runtime, dict) else ""
    if "ModuleNotFoundError: No module named 'deeptutor'" in log:
        raise RuntimeError("fresh Tutor image still cannot import the bundled deeptutor package")
    if "Traceback (most recent call last):" in log and port_probe != "http-200":
        detail = safe_failure_detail(log)
        raise RuntimeError(f"fresh Tutor image failed during startup:\n{detail}")

    status = wait_until_ready(base)
    if status.get("ready") is not True or status.get("httpStatus") != 200:
        detail = safe_failure_detail(log)
        raise RuntimeError(
            "fresh Tutor image deployed but did not become ready on port 3782"
            + (f"\n{detail}" if detail else "")
        )

    print(
        f"[Murikah Tutor] Deployment verified: image {expected_revision}, "
        "port 3782 healthy."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"Murikah Tutor deployment command failed with exit code {exc.returncode}.", file=sys.stderr)
        raise
