#!/usr/bin/env python3
"""Validate every committed Virtual Internship scenario pack without network/model access."""
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.validator import SCENARIOS_ROOT, ScenarioValidationError, validate_all

def main()->int:
    try:
        rows=validate_all(SCENARIOS_ROOT)
    except ScenarioValidationError as exc:
        print(f"Virtual Internship Phase 2 scenario validation: FAIL\n - {exc}")
        return 1
    except Exception as exc:
        print(f"Virtual Internship Phase 2 scenario validation: FAIL\n - {type(exc).__name__}: {exc}")
        return 1
    for path,digest in rows:
        print(f" - {path.relative_to(SCENARIOS_ROOT)} {digest}")
    print(f"Virtual Internship Phase 2 scenario validation: PASS ({len(rows)} packs)")
    return 0
if __name__=="__main__":raise SystemExit(main())
