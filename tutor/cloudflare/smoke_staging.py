#!/usr/bin/env python3
"""Post-deploy smoke test for Murikah Tutor Cloudflare staging.

Runs in Cloudflare Workers Builds after `wrangler deploy`. It never reads secret
values. It first verifies that the deployed Worker can see the required secret,
then waits for the real Tutor health route. On failure it prints safe isolated
startup diagnostics so the build log contains the root cause automatically.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.environ.get(
    "MURIKAH_TUTOR_STAGING_URL",
    "https://murikah-tutor-container-staging.hasspe.workers.dev",
).rstrip("/")
DEADLINE_SECONDS = int(os.environ.get("MURIKAH_TUTOR_SMOKE_TIMEOUT", "300"))


def get(path: str, timeout: float = 8.0) -> tuple[int, str]:
    request = urllib.request.Request(
        BASE_URL + path,
        headers={"User-Agent": "murikah-tutor-deploy-smoke/1.2", "Cache-Control": "no-store"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8", "replace")


def parse_json(body: str) -> dict:
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def main() -> int:
    print(f"Murikah Tutor staging smoke test: {BASE_URL}")

    # This proves the secret exists in the deployed Worker execution context,
    # not merely in dashboard metadata. No secret value or length is returned.
    try:
        config_code, config_body = get("/__muri/worker-config")
        config = parse_json(config_body)
    except Exception as exc:
        print(f"Murikah Tutor staging smoke test: FAILED - Worker config probe: {type(exc).__name__}: {exc}")
        return 1

    if config_code != 200 or config.get("adminPasswordConfigured") is not True:
        print("Murikah Tutor staging smoke test: FAILED - required Worker secret is not visible at runtime")
        print(f"Worker config status: HTTP {config_code} {config_body[:1000]}")
        return 1

    print(" - Worker runtime can see the required admin secret")
    started = time.monotonic()
    last: dict = {}

    while time.monotonic() - started < DEADLINE_SECONDS:
        try:
            status_code, body = get("/__muri/runtime-status")
            parsed = parse_json(body)
            if parsed:
                last = parsed
                elapsed = int(time.monotonic() - started)
                state = parsed.get("state")
                state_name = state.get("status") if isinstance(state, dict) else None
                print(
                    f" - {elapsed:>3}s status={status_code} running={parsed.get('running')} "
                    f"ready={parsed.get('ready')} http={parsed.get('httpStatus')} "
                    f"state={state_name or 'unknown'} error={str(parsed.get('error') or '')[:160]}"
                )
                if parsed.get("workerSecretConfigured") is False:
                    print("Murikah Tutor staging smoke test: FAILED - Worker secret disappeared during startup")
                    return 1
                if parsed.get("ready") is True:
                    health_code, health_body = get("/health")
                    if health_code == 200:
                        print("Murikah Tutor staging smoke test: PASS")
                        print(" - edge Worker reachable")
                        print(" - Tutor frontend listening on 3782")
                        print(" - Tutor backend readiness passed")
                        return 0
                    print(
                        f" - readiness probe passed but /health returned HTTP {health_code}: "
                        f"{health_body[:300]}"
                    )
            else:
                print(f" - runtime-status HTTP {status_code} returned non-JSON; retrying")
        except Exception as exc:
            print(f" - probe retry: {type(exc).__name__}: {exc}")
        time.sleep(2)

    print("Murikah Tutor staging smoke test: FAILED")
    print(f"Last runtime status: {json.dumps(last, sort_keys=True)[:3000]}")
    try:
        code, diagnostics = get("/__muri/container-diagnostics", timeout=40.0)
        print(f"Safe startup diagnostics (HTTP {code}):")
        print(diagnostics[:12000])
    except Exception as exc:
        print(f"Diagnostics unavailable: {type(exc).__name__}: {exc}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
