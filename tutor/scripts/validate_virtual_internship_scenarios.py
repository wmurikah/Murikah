#!/usr/bin/env python3
"""Validate every committed Virtual Internship scenario pack without network/model access."""
from pathlib import Path
import json
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.template_resolver import load_templates
from virtual_internship.validator import SCENARIOS_ROOT, ScenarioValidationError, validate_all


def main()->int:
    try:
        rows=validate_all(SCENARIOS_ROOT)
        templates=load_templates()
        registry=json.loads((ROOT/"virtual-internship/career-families.v1.json").read_text(encoding="utf-8"))
    except ScenarioValidationError as exc:
        print(f"Virtual Internship Phase 10 scenario validation: FAIL\n - {exc}")
        return 1
    except Exception as exc:
        print(f"Virtual Internship Phase 10 scenario validation: FAIL\n - {type(exc).__name__}: {exc}")
        return 1

    production=[path for path,_ in rows if "production" in path.parts]
    practice=[path for path,_ in rows if path.name.endswith("-v3")]
    historical=[path for path,_ in rows if "demo" in path.parts and not path.name.endswith("-v3")]
    families=[row for row in registry.get("families",[]) if isinstance(row,dict) and row.get("active") is True]
    errors=[]
    if len(rows)!=15: errors.append(f"expected 15 total packs, found {len(rows)}")
    if len(production)!=6: errors.append(f"expected 6 production qualifying packs, found {len(production)}")
    if len(practice)!=3: errors.append(f"expected 3 Phase 10 practice packs, found {len(practice)}")
    if len(historical)!=6: errors.append(f"expected 6 historical demo packs, found {len(historical)}")
    if len(templates)!=6: errors.append(f"expected 6 published reusable templates, found {len(templates)}")
    if len(families)!=6: errors.append(f"expected 6 active career families, found {len(families)}")
    if errors:
        print("Virtual Internship Phase 10 scenario validation: FAIL")
        for error in errors: print(f" - {error}")
        return 1

    for path,digest in rows:
        print(f" - {path.relative_to(SCENARIOS_ROOT)} {digest}")
    print(f"Virtual Internship Phase 2 scenario validation: PASS (6 historical packs preserved)")
    print(f"Virtual Internship Phase 10 scenario validation: PASS ({len(rows)} packs, {len(families)} career families, {len(templates)} templates)")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
