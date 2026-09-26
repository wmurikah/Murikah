#!/usr/bin/env python3
"""Phase 10 Cloudflare preflight layered on the preserved Phase 1-9 gate."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEGACY = Path(__file__).with_name("preflight_legacy.py")

spec = importlib.util.spec_from_file_location("murikah_cloudflare_preflight_legacy", LEGACY)
if spec is None or spec.loader is None:
    raise SystemExit("Could not load preserved Cloudflare preflight.")
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


def validate_virtual_internship_phase10_fixture() -> None:
    """Validate legacy demos, Phase 10 practice versions and six production packs."""
    railway = str(ROOT / "tutor/railway")
    if railway not in sys.path:
        sys.path.insert(0, railway)
    try:
        from virtual_internship.validator import SCENARIOS_ROOT, validate_all
        rows = validate_all(SCENARIOS_ROOT)
    except Exception as exc:
        legacy.failures.append(f"Virtual Internship Phase 10 scenario validation failed: {exc}")
        return
    relative = [str(path.relative_to(SCENARIOS_ROOT)).replace("\\", "/") for path, _digest in rows]
    production = [path for path in relative if path.startswith("production/")]
    practice_v3 = [path for path in relative if path.startswith("demo/") and path.endswith("-v3")]
    legacy_demo = [path for path in relative if path.startswith("demo/") and not path.endswith("-v3")]
    if len(rows) != 15:
        legacy.failures.append(f"Virtual Internship Phase 10 expected 15 validated packs, found {len(rows)}")
    if len(production) != 6:
        legacy.failures.append(f"Virtual Internship Phase 10 expected 6 production packs, found {len(production)}")
    if len(practice_v3) != 3:
        legacy.failures.append(f"Virtual Internship Phase 10 expected 3 catalog practice v3 packs, found {len(practice_v3)}")
    if len(legacy_demo) != 6:
        legacy.failures.append(f"Virtual Internship legacy regression expected 6 historical demo packs, found {len(legacy_demo)}")


def phase10_markers() -> None:
    require = legacy.require_markers
    forbid = legacy.forbid_markers
    require(
        "tutor/cloudflare/migrations/0016_virtual_internship_phase10_catalog.sql",
        (
            "CREATE TABLE IF NOT EXISTS career_families",
            "CREATE TABLE IF NOT EXISTS internship_catalog_entries",
            "CREATE TABLE IF NOT EXISTS scenario_templates",
            "CREATE TABLE IF NOT EXISTS scenario_template_versions",
            "CREATE TABLE IF NOT EXISTS institution_scenario_drafts",
            "idx_catalog_visible_type_sort",
            "idx_catalog_family",
            "idx_catalog_sector",
            "idx_catalog_workload",
            "idx_catalog_experience",
            "idx_catalog_one_current_slug",
            "trg_published_institution_draft_immutable",
            "virtual_internship_phase10_schema_version",
        ),
    )
    for schema, marker in (
        ("career-family.schema.json", "career-family-registry-v1"),
        ("catalog-metadata.schema.json", "catalog-metadata-v1"),
        ("scenario-template.schema.json", "scenario-template-v1"),
    ):
        require(f"tutor/virtual-internship/schema/v1/{schema}", (marker, '"additionalProperties": false'))
    require(
        "tutor/virtual-internship/career-families.v1.json",
        (
            "cf_audit_assurance_v1",
            "cf_data_analytics_v1",
            "cf_software_engineering_v1",
            "cf_cybersecurity_v1",
            "cf_finance_v1",
            "cf_project_operations_v1",
            "physical_competency_classification",
        ),
    )
    require(
        "tutor/railway/virtual_internship/template_resolver.py",
        (
            "MAX_INHERITANCE_DEPTH = 8",
            "template_content_hash",
            "resolve_template_sections",
            "resolve_scenario_pack",
            "inheritance cycle",
            "duplicate inherited template",
            "template hash mismatch",
            "_merge_keyed",
        ),
    )
    require(
        "tutor/railway/virtual_internship/phase10_validation.py",
        (
            "qualifying Phase 10 scenario requires catalog metadata",
            "approximately 13-week progression",
            "qualifying Phase 10 scenario requires several workplace actors",
            "requires an ethics and escalation event",
            "requires a workplace-dynamics event",
            "practice internships must not install a qualifying completion policy",
        ),
    )
    require(
        "tutor/cloudflare/src/virtual_internship_phase10.ts",
        (
            "/catalog/list",
            "/catalog/facets",
            "/catalog/detail",
            "/catalog/project",
            "resolveCatalogStartAuthority",
            "scenario_version_required",
            "scenario_version_retired",
            "completion_policy_missing",
            "/institution-scenarios/draft",
            "/institution-scenarios/get",
            "/institution-scenarios/validation",
            "/institution-scenarios/stage",
            "/institution-scenarios/activate",
            "/institution-scenarios/publish-state",
            "/institution-scenarios/retire",
            "published_scenario_immutable",
            "canonical-pack-v1",
        ),
    )
    forbid(
        "tutor/cloudflare/src/virtual_internship_phase10.ts",
        ("OpenAI", "Claude", "Gemini", "Qwen", "NVIDIA", "Math.random("),
    )
    require(
        "tutor/cloudflare/src/index.ts",
        (
            "handlePhase10CatalogPersistenceRoute",
            "resolveCatalogStartAuthority",
            "scenario_version_required",
            "active_internship_exists",
            "qualifying ? 1 : 0",
        ),
    )
    require(
        "tutor/railway/murikah_persistence.py",
        (
            "def internship_catalog_list(",
            "def internship_catalog_facets(",
            "def internship_catalog_detail(",
            "def internship_catalog_project(",
            "def institution_scenario_draft(",
            "def institution_scenario_validation(",
            "def institution_scenario_publish_state(",
            "def institution_scenario_retire(",
        ),
    )
    require(
        "tutor/railway/virtual_internship/institution.py",
        (
            "validate_institution_draft",
            "resolve_scenario_pack",
            "validate_pack(root, verify_hash=True)",
            "FORBIDDEN_EXECUTABLE_KEYS",
            "publish_saved_draft",
            "scenario_definition_install",
            "scenario_completion_policy_install",
            "internship_catalog_project",
            "validated draft content changed before publication",
        ),
    )
    require(
        "tutor/railway/murikah_virtual_internship_admin.py",
        (
            '@router.post("/drafts")',
            '@router.get("/drafts/{draft_id}")',
            '@router.post("/drafts/{draft_id}/validate")',
            '@router.post("/drafts/{draft_id}/publish")',
            '@router.post("/drafts/{draft_id}/retire")',
        ),
    )
    require(
        "tutor/railway/murikah_virtual_internship.py",
        (
            '@router.get("/catalog")',
            '@router.get("/catalog/facets")',
            '@router.get("/catalog/{catalog_slug}")',
            "scenario_version_id: str = Field",
            "body.scenario_version_id",
        ),
    )
    require(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        (
            "Choose your Virtual Internship",
            "Qualifying Virtual Internships",
            "Practice internships",
            "Search internships...",
            "Career family",
            "Weekly workload",
            "Review your commitment",
            "I understand that this is a simulated internship",
            "elapsed time alone does not complete the internship",
            "only one qualifying internship may be active at a time",
            "scenario_version_id: scenarioVersionId",
            "Does not qualify for completion credentials",
            "server_current_time",
        ),
    )
    forbid(
        "tutor/railway/MurikahVirtualInternshipWorkspace.tsx.txt",
        ("No internship is available right now.",),
    )
    for pack in (
        "internal-audit-v1",
        "data-analyst-v1",
        "software-engineering-v1",
        "cybersecurity-analyst-v1",
        "financial-analyst-v1",
        "project-management-v1",
    ):
        require(
            f"tutor/virtual-internship/scenarios/production/{pack}/manifest.json",
            ('"classification": "qualifying"', '"qualifying": true', '"minimum_duration_days": 90', '"catalog"'),
        )
        require(f"tutor/virtual-internship/scenarios/production/{pack}/completion.json", ('"require_final_review": true', '"capstone_task_ids"'))
    for pack in ("internal-audit-v3", "data-analyst-v3", "software-engineering-v3"):
        require(
            f"tutor/virtual-internship/scenarios/demo/{pack}/manifest.json",
            ('"classification": "demo"', '"qualifying": false', '"internship_type": "practice"'),
        )
    for template in (
        "standard-90-day-knowledge-work-v1.json",
        "common-workplace-communication-v1.json",
        "standard-midpoint-review-v1.json",
        "standard-final-review-v1.json",
        "standard-completion-disclosure-v1.json",
        "shared-ethics-event-patterns-v1.json",
    ):
        require(f"tutor/virtual-internship/templates/v1/{template}", ('"template_version": 1', '"content_hash"', '"status": "published"'))
    for test_file, marker in (
        ("test_virtual_internship_career_families.py", "class Phase10CareerFamilyTests"),
        ("test_virtual_internship_catalog.py", "class Phase10CatalogTests"),
        ("test_virtual_internship_catalog_start.py", "class Phase10CatalogStartTests"),
        ("test_virtual_internship_templates.py", "class Phase10TemplateTests"),
        ("test_virtual_internship_production_packs.py", "class Phase10ProductionPackTests"),
        ("test_virtual_internship_practice_catalog.py", "class Phase10PracticeCatalogTests"),
        ("test_virtual_internship_institution_scenarios.py", "class Phase10InstitutionScenarioTests"),
    ):
        require(f"tutor/tests/{test_file}", (marker,))
    require(
        "tutor/tests/virtual-internship-catalog.spec.tsx.txt",
        (
            "Phase 10 Virtual Internship catalog",
            "Qualifying Virtual Internships",
            "Practice internships",
            "Review your commitment",
            "scenario_version_id",
        ),
    )
    require(
        "tutor/Dockerfile.railway",
        (
            "murikah_virtual_internship_admin.py",
            "COPY tutor/virtual-internship /app/virtual-internship",
            "validate_virtual_internship_scenarios.py",
            "virtual-internship-catalog.spec.tsx",
        ),
    )
    require(
        "tutor/cloudflare/PERSISTENCE.md",
        ("Virtual Internship Phase 10", "0016_virtual_internship_phase10_catalog.sql"),
    )
    require(
        "tutor/virtual-internship/README.md",
        (
            "## Phase 10 Implementation Record",
            "## SUBSEQUENT CAREER CATALOG DEVELOPMENT REQUIREMENT",
            "Phase 11 longitudinal evaluation remains unimplemented",
        ),
    )


def legacy_phase2_fixture() -> None:
    """Retain the exact historical six-demo-pack regression inside the legacy preflight."""
    railway = str(ROOT / "tutor/railway")
    if railway not in sys.path:
        sys.path.insert(0, railway)
    try:
        from virtual_internship.validator import validate_all
        demo_root = ROOT / "tutor/virtual-internship/scenarios/demo"
        rows = [row for row in validate_all(demo_root) if not row[0].name.endswith("-v3")]
    except Exception as exc:
        legacy.failures.append(f"Virtual Internship historical scenario validation failed: {exc}")
        return
    if len(rows) != 6:
        legacy.failures.append(f"Virtual Internship historical regression expected 6 Phase 2/6 demos, found {len(rows)}")


def main() -> int:
    # Override only the legacy count assumption. Every other Phase 1-9 guard in
    # preflight_legacy.py still executes unchanged.
    legacy.validate_virtual_internship_phase2_fixture = legacy_phase2_fixture
    phase10_markers()
    validate_virtual_internship_phase10_fixture()
    return legacy.main()


if __name__ == "__main__":
    raise SystemExit(main())
