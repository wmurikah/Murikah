#!/usr/bin/env python3
"""Deploy Murikah Tutor without treating Cloudflare's asynchronous rollout as a failure.

Cloudflare activates Worker code before every container instance is replaced.
The deployment gate therefore verifies the live application instance through
/__muri/runtime-status, which reports the revision from the actual container
health route. It never deletes/recreates the container application merely
because a diagnostic instance is temporarily stale or unknown.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "wrangler.toml"
VERIFY_BASES = (
    "https://murikah-tutor-container-staging.hasspe.workers.dev",
    "https://tutor.murikah.com",
)
APPLICATION_NOT_FOUND = "APPLICATION_NOT_FOUND"
CREATE_TEMPORARILY_UNAVAILABLE = "can't create application at this time"
TRANSIENT_DEPLOY_ERRORS = (
    APPLICATION_NOT_FOUND.casefold(),
    CREATE_TEMPORARILY_UNAVAILABLE.casefold(),
    "application is being deleted",
    "application is currently being deleted",
    "try again later",
    "no such manifest:",
    "manifest unknown",
)
DEFAULT_RUNTIME_ROLLOUT_TIMEOUT_SECONDS = 360


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
    image_match = re.search(
        r'MURIKAH_CLOUDFLARE_IMAGE_REV\s*=\s*"([^"]+)"',
        text,
    )
    worker_match = re.search(
        r'MURIKAH_EXPECTED_IMAGE_REV\s*=\s*"([^"]+)"',
        text,
    )
    if not image_match:
        raise RuntimeError("MURIKAH_CLOUDFLARE_IMAGE_REV is missing from wrangler.toml")
    if not worker_match:
        raise RuntimeError("MURIKAH_EXPECTED_IMAGE_REV is missing from wrangler.toml")
    image_revision = image_match.group(1).strip()
    worker_revision = worker_match.group(1).strip()
    if not image_revision or image_revision != worker_revision:
        raise RuntimeError(
            "Cloudflare image build revision and Worker expected revision must match"
        )
    return image_revision


def run_wrangler(
    *args: str,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    command = [wrangler_path(), *args, "--config", str(CONFIG)]
    environment = os.environ.copy()
    environment["CI"] = "true"
    return subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def emit_completed_process(result: subprocess.CompletedProcess[str]) -> None:
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n", flush=True)
    if result.stderr:
        print(
            result.stderr,
            end="" if result.stderr.endswith("\n") else "\n",
            file=sys.stderr,
            flush=True,
        )


def apply_persistence_migrations() -> None:
    print(
        "[Murikah Tutor] Applying version-controlled D1 persistence migrations.",
        flush=True,
    )
    result = run_wrangler(
        "d1",
        "migrations",
        "apply",
        "murikah-tutor-prod",
        "--remote",
        capture=True,
        check=False,
    )
    emit_completed_process(result)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            result.args,
            output=result.stdout,
            stderr=result.stderr,
        )


def is_transient_deploy_error(output: str) -> bool:
    folded = output.casefold()
    return any(marker in folded for marker in TRANSIENT_DEPLOY_ERRORS)


def deploy(*, attempts: int = 6) -> str:
    """Run one logical deploy, retrying only a command that actually failed.

    Wrangler may mention a transient registry/control-plane condition while
    still exiting 0 after successfully publishing the Worker and target
    container configuration. Re-running a successful deploy creates needless
    rollout churn, so exit code 0 is authoritative here.
    """
    delays = (8, 13, 20, 30, 45)
    last_output = ""
    for attempt in range(1, attempts + 1):
        result = run_wrangler(
            "deploy",
            "--containers-rollout=immediate",
            capture=True,
            check=False,
        )
        emit_completed_process(result)
        last_output = f"{result.stdout or ''}\n{result.stderr or ''}"
        if result.returncode == 0:
            print(
                "[Murikah Tutor] Wrangler accepted the Worker + container target; "
                "observing the asynchronous container rollout.",
                flush=True,
            )
            return last_output
        if attempt >= attempts or not is_transient_deploy_error(last_output):
            raise subprocess.CalledProcessError(
                result.returncode,
                result.args,
                output=result.stdout,
                stderr=result.stderr,
            )
        delay = delays[min(attempt - 1, len(delays) - 1)]
        print(
            "[Murikah Tutor] Cloudflare deploy command failed with a transient "
            f"control-plane/registry condition; retrying in {delay}s "
            f"({attempt}/{attempts}).",
            flush=True,
        )
        time.sleep(delay)
    raise RuntimeError("Tutor deploy retry loop exhausted unexpectedly")


def fetch_json(base: str, path: str, *, timeout: float) -> dict[str, Any]:
    separator = "&" if "?" in path else "?"
    url = f"{base.rstrip('/')}{path}{separator}deploy_check={time.time_ns()}"
    request = Request(
        url,
        headers={
            "accept": "application/json",
            "cache-control": "no-cache",
            "user-agent": "Murikah-Tutor-Deploy-Verification/2.0",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"unexpected JSON payload from {base}{path}")
    return payload


def runtime_revision(status: dict[str, Any]) -> str:
    return str(status.get("imageRevision") or "").strip()


def runtime_rollout_timeout() -> int:
    raw = os.environ.get("MURIKAH_TUTOR_ROLLOUT_TIMEOUT_SECONDS", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_RUNTIME_ROLLOUT_TIMEOUT_SECONDS
    except ValueError:
        value = DEFAULT_RUNTIME_ROLLOUT_TIMEOUT_SECONDS
    return min(max(value, 120), 600)


def wait_for_expected_runtime(
    expected_revision: str,
    *,
    timeout_seconds: int,
) -> tuple[dict[str, Any], str]:
    """Wait for the main Tutor instance, not the disposable diagnostic instance.

    The new Worker can become active before Cloudflare replaces the old
    container image. /__muri/runtime-status is deliberately non-cached and
    reports the image revision returned by the live container's /health route.
    """
    deadline = time.monotonic() + timeout_seconds
    last_status: dict[str, Any] = {}
    last_base = VERIFY_BASES[0]
    last_error = ""
    last_line = ""

    while time.monotonic() < deadline:
        for base in VERIFY_BASES:
            try:
                status = fetch_json(base, "/__muri/runtime-status", timeout=12)
                last_status = status
                last_base = base
                revision = runtime_revision(status)
                line = (
                    "[Murikah Tutor] Live rollout check: "
                    f"running={bool(status.get('running'))} "
                    f"ready={bool(status.get('ready'))} "
                    f"http={status.get('httpStatus', 'unknown')} "
                    f"image={revision or 'unknown'} "
                    f"expected={expected_revision}."
                )
                if line != last_line:
                    print(line, flush=True)
                    last_line = line

                if status.get("workerSecretConfigured") is False:
                    raise RuntimeError(
                        "startup-critical Worker secrets are unavailable at runtime"
                    )

                if (
                    status.get("ready") is True
                    and status.get("httpStatus") == 200
                    and revision == expected_revision
                ):
                    return status, base
            except RuntimeError:
                raise
            except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(3)

    summary = {
        "running": last_status.get("running"),
        "ready": last_status.get("ready"),
        "httpStatus": last_status.get("httpStatus"),
        "imageRevision": runtime_revision(last_status) or "unknown",
        "expectedImageRevision": expected_revision,
        "error": str(last_status.get("error") or "")[:300],
    }
    raise RuntimeError(
        "Cloudflare accepted the deployment, but the live Tutor instance did not "
        f"converge to image {expected_revision} within {timeout_seconds}s. "
        f"Last status={json.dumps(summary, sort_keys=True)}"
        + (f"; last probe error={last_error}" if last_error else "")
    )


def startup_log(report: dict[str, Any]) -> str:
    value = report.get("startupLog")
    return str(value.get("output", "")) if isinstance(value, dict) else ""


def safe_failure_detail(log: str) -> str:
    blocked = ("password", "secret", "token", "api_key", "client_secret", "private_key")
    lines = []
    for line in log.splitlines():
        low = line.lower()
        lines.append("<redacted diagnostic line>" if any(x in low for x in blocked) else line)
    return "\n".join(lines[-24:])


def one_failure_diagnostic() -> str:
    """Collect one isolated diagnostic only after rollout verification fails."""
    last_error = ""
    for base in VERIFY_BASES:
        try:
            report = fetch_json(base, "/__muri/container-diagnostics", timeout=45)
            image = report.get("image")
            image_output = (
                str(image.get("output", "")) if isinstance(image, dict) else ""
            )
            revision_match = re.search(
                r"(?m)^image-revision=([^\r\n]+)$",
                image_output,
            )
            revision = revision_match.group(1).strip() if revision_match else ""
            runtime = report.get("runtime")
            port_probe = (
                str(runtime.get("port3782", ""))
                if isinstance(runtime, dict)
                else ""
            )
            parts = [
                f"diagnostic-image={revision or 'unknown'}",
                f"diagnostic-port3782={port_probe or 'unknown'}",
            ]
            log = safe_failure_detail(startup_log(report))
            if log:
                parts.append(log)
            return "\n".join(parts)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
    return f"diagnostics unavailable: {last_error or 'unknown error'}"


def main() -> int:
    expected_revision = expected_image_revision()
    apply_persistence_migrations()
    deploy()

    try:
        _, base = wait_for_expected_runtime(
            expected_revision,
            timeout_seconds=runtime_rollout_timeout(),
        )
    except RuntimeError as exc:
        detail = one_failure_diagnostic()
        raise RuntimeError(f"{exc}\n{detail}") from exc

    print(
        "[Murikah Tutor] Deployment verified non-destructively: "
        f"live image {expected_revision}, port 3782 healthy via {base}.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(
            f"Murikah Tutor deployment command failed with exit code {exc.returncode}.",
            file=sys.stderr,
            flush=True,
        )
        raise
