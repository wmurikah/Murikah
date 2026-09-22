#!/usr/bin/env python3
"""Read-only lifecycle acceptance probe for Murikah Tutor persistence.

Usage:
  python tutor/cloudflare/verify_persistence_lifecycle.py --snapshot /tmp/before.json
  # sleep/wake, deploy, forced container replacement or rollback
  python tutor/cloudflare/verify_persistence_lifecycle.py --verify /tmp/before.json

The script never destroys a container and never reads learner content. It
compares aggregate durable-state counts and requires the D1 ownership registry
to be fully reconciled after the lifecycle event.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import urllib.error
import urllib.request


DEFAULT_BASE = "https://tutor.murikah.com"
FIELDS = (
    "durableObjectCount",
    "ownedObjectCount",
    "userOwnedObjectCount",
    "activeAccountCount",
    "learningTurnCount",
)


def get_json(base: str, path: str) -> dict:
    request = urllib.request.Request(
        base.rstrip("/") + path,
        headers={"User-Agent": "Murikah-Persistence-Acceptance/1.0", "Cache-Control": "no-store"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"{path} returned HTTP {response.status}")
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{path} returned HTTP {exc.code}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{path} did not return a JSON object")
    return value


def snapshot(base: str) -> dict:
    status = get_json(base, "/__muri/persistence-status")
    if status.get("ok") is not True:
        raise RuntimeError("Tutor persistence status is not healthy")
    if status.get("schemaVersion") != "1":
        raise RuntimeError("Base persistence schema is not ready")
    if status.get("learningJournalSchemaVersion") != "2":
        raise RuntimeError("Learning journal schema v2 is not ready")
    if status.get("followupFastPathSchemaVersion") != "1":
        raise RuntimeError("Follow-up fast-path schema is not ready")
    if status.get("ownershipSchemaVersion") != "1":
        raise RuntimeError("Ownership schema is not ready")
    if int(status.get("unregisteredObjectCount") or 0) != 0:
        raise RuntimeError("Durable R2 manifest contains objects without D1 ownership records")
    return {field: int(status.get(field) or 0) for field in FIELDS}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=DEFAULT_BASE)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--snapshot", type=Path)
    group.add_argument("--verify", type=Path)
    args = parser.parse_args()

    current = snapshot(args.base)
    if args.snapshot:
        args.snapshot.write_text(
            json.dumps(current, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"Saved persistence acceptance baseline to {args.snapshot}")
        print(json.dumps(current, sort_keys=True))
        return 0

    before = json.loads(args.verify.read_text(encoding="utf-8"))
    failures: list[str] = []
    for field in FIELDS:
        old = int(before.get(field) or 0)
        new = int(current.get(field) or 0)
        if new < old:
            failures.append(f"{field} decreased from {old} to {new}")

    if current["ownedObjectCount"] < current["durableObjectCount"]:
        failures.append(
            "ownedObjectCount is lower than durableObjectCount after reconciliation"
        )

    if failures:
        print("Murikah Tutor persistence lifecycle acceptance: FAILED")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Murikah Tutor persistence lifecycle acceptance: PASS")
    print(" - D1 ownership registry is fully reconciled")
    print(" - durable object/account/learning counts did not regress")
    print(json.dumps(current, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
