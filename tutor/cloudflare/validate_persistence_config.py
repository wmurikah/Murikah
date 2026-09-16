#!/usr/bin/env python3
"""Fail closed if the production Tutor persistence bindings drift."""
from __future__ import annotations

from pathlib import Path
import sys
import tomllib

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "wrangler.toml"
EXPECTED_D1 = {
    "binding": "TUTOR_DB",
    "database_name": "murikah-tutor-prod",
    "database_id": "e8916f9a-fc2e-4bc6-925f-76c6c401c95b",
}
EXPECTED_R2 = {
    "binding": "TUTOR_FILES",
    "bucket_name": "murikah-tutor-files-prod",
}


def exact_match(items: object, expected: dict[str, str]) -> bool:
    if not isinstance(items, list):
        return False
    return any(
        isinstance(item, dict)
        and all(str(item.get(key, "")) == value for key, value in expected.items())
        for item in items
    )


def main() -> int:
    config = tomllib.loads(CONFIG.read_text(encoding="utf-8"))
    failures: list[str] = []

    if not exact_match(config.get("d1_databases"), EXPECTED_D1):
        failures.append("TUTOR_DB must bind exactly to murikah-tutor-prod and its approved database id")
    if not exact_match(config.get("r2_buckets"), EXPECTED_R2):
        failures.append("TUTOR_FILES must bind exactly to the private murikah-tutor-files-prod bucket")
    if config.get("keep_vars") is not True:
        failures.append("keep_vars=true must remain enabled so dashboard service configuration survives deploys")

    if failures:
        print("Murikah Tutor persistence binding validation: FAILED")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Murikah Tutor persistence binding validation: PASS")
    print(" - TUTOR_DB -> murikah-tutor-prod")
    print(" - TUTOR_FILES -> murikah-tutor-files-prod (private binding; no credentials in repo)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
