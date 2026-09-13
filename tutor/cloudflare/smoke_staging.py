#!/usr/bin/env python3
"""Post-deploy smoke test for Murikah Tutor Cloudflare staging.

Runs in Cloudflare Workers Builds after `wrangler deploy`. It never reads secrets.
It waits for the public runtime-status endpoint to report the actual Tutor health
route as ready, then verifies /health. On failure it prints the safe isolated
startup diagnostic so the build log contains the root cause automatically.
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
# Cloudflare activates Worker code before a container rollout has necessarily
# replaced every old instance. Staging uses immediate rollout + zero grace, but
# still allow several minutes for image provisioning/replacement before failing.
DEADLINE_SECONDS = int(os.environ.get("MURIKAH_TUTOR_SMOKE_TIMEOUT", "300"))


def get(path: str, timeout: float = 8.0) -> tuple[int, str]:
    request = urllib.request.Request(
        BASE_URL + path,
        headers={"User-Agent": "murikah-tutor-deploy-smoke/1.1", "Cache-Control": "no-store"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8", "replace")


def main() -> int:
    print(f"Murikah Tutor staging smoke test: {BASE_URL}")
    started = time.monotonic()
    last: dict = {}

    while time.monotonic() - started < DEADLINE_SECONDS:
        try:
            status_code, body = get("/__muri/runtime-status")
            if status_code == 200:
                parsed = json.loads(body)
                if isinstance(parsed, dict):
                    last = parsed
                    elapsed = int(time.monotonic() - started)
                    state = parsed.get("state")
                    state_name = state.get("status") if isinstance(state, dict) else None
                    print(
                        f" - {elapsed:>3}s running={parsed.get('running')} "
                        f"ready={parsed.get('ready')} http={parsed.get('httpStatus')} "
                        f"state={state_name or 'unknown'}"
                    )
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
        except Exception as exc:  # network/DNS and rollout state can settle after deploy
            print(f" - probe retry: {type(exc).__name__}: {exc}")
        time.sleep(2)

    print("Murikah Tutor staging smoke test: FAILED")
    print(f"Last runtime status: {json.dumps(last, sort_keys=True)[:3000]}")
    try:
        code, diagnostics = get("/__muri/container-diagnostics", timeout=35.0)
        print(f"Safe startup diagnostics (HTTP {code}):")
        print(diagnostics[:12000])
    except Exception as exc:
        print(f"Diagnostics unavailable: {type(exc).__name__}: {exc}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
