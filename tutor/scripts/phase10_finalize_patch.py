from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODE = sys.argv[1] if len(sys.argv) > 1 else "prepare"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        if new in text:
            return text
        raise SystemExit(f"missing expected marker for {label}: {old!r}")
    return text.replace(old, new, 1)


if MODE == "prepare":
    # Frontend regression contract: make the release-gate markers real assertions.
    test_path = "tutor/tests/virtual-internship-catalog.spec.tsx.txt"
    text = read(test_path)
    text = replace_once(
        text,
        'describe("Virtual Internship Phase 10 catalog", () => {',
        'describe("Phase 10 Virtual Internship catalog", () => {',
        "catalog describe marker",
    )
    commitment_anchor = '    const start = await screen.findByRole("button", { name: "Start internship" });'
    commitment_assertion = (
        '    expect(await screen.findByRole("heading", { level: 1, name: "Review your commitment" })).toBeTruthy();\n'
        + commitment_anchor
    )
    text = replace_once(text, commitment_anchor, commitment_assertion, "commitment heading assertion")
    write(test_path, text)

    # Phase 9's forward-looking statement must no longer say Phase 10 is unimplemented.
    readme_path = "tutor/virtual-internship/README.md"
    readme = read(readme_path)
    readme = readme.replace(
        "Phase 10 career catalog remains unimplemented. Phase 11 longitudinal evaluation remains unimplemented.",
        "Phase 10 career catalog is implemented below. Phase 11 longitudinal evaluation remains unimplemented.",
    )

    record = r'''

## Phase 10 Implementation Record

Status: **implemented; release-gate verification is recorded by the focused Phase 10 branch.** Phase 10 consumes the Phase 1 through Phase 9 lifecycle, workplace, artifact, assessment, Competency Passport, completion, report and letter systems. It does not create a second internship engine, start API, completion system, competency system or scenario store.

### Career catalog and learner journey

The no-active-internship experience at `/virtual-internship` is now the learner-facing catalog headed **Choose your Virtual Internship**. It provides deterministic search and filters, qualifying internship cards, a separate Practice internships section, stable detail routes, a commitment review step and exact-version start. An active qualifying internship still opens the existing workplace. Guests may browse catalog/list/detail metadata, while starting a qualifying internship routes through the existing authentication flow and remains verified-member only.

The catalog is projected from validated authored scenario manifests into D1. Browser code does not author qualification, mode, minimum duration or credential eligibility. Catalog cards and detail responses pin an exact published `scenario_version_id`; start continues to use `POST /__muri/persist/internships/start` and server-side lifecycle validation.

### Phase 10 storage and migration

The primary Phase 10 migration is `tutor/cloudflare/migrations/0016_virtual_internship_phase10_catalog.sql`. It adds the normalized career/catalog/template/institution structures used by Phase 10, including `career_families`, `internship_catalog_entries`, `scenario_templates`, `scenario_template_versions` and the controlled institution scenario draft/publishing state.

A forward-only correction in `tutor/cloudflare/migrations/0017_virtual_internship_phase10_template_retirement_fix.sql` clears an erroneous `retired_at` value from template versions whose authoritative status is `published`. The historical `0016` migration is not rewritten, so already-applied databases are repaired safely.

### Career-family and physical-scope model

`tutor/virtual-internship/career-families.v1.json` and the Phase 10 schemas provide stable IDs, versioned slugs, descriptions, ordering and physical-competency classification. Catalog UI is data-driven rather than branching on display labels. Physical-scope classifications distinguish knowledge work from mixed or physical-skill-limited scenarios; learner-facing limitation text is shown only when relevant and prior Passport/report limitation safeguards remain authoritative.

### Production and practice internships

Phase 10 publishes six distinct qualifying, standard-mode, 90+ day production packs using fictional organizations:

1. Internal Audit Intern.
2. Data Analyst Intern.
3. Software Engineering Intern.
4. Cybersecurity Analyst Intern.
5. Financial Analyst Intern.
6. Project Management Intern.

Each production pack uses the common scenario engine, multi-week task/event progression, workplace actors and communications, mapped artifacts, rubrics and competency evidence, midpoint/final review, capstone work and a non-empty Phase 8 completion policy. The Phase 9 report and letter systems therefore receive role, organization, workload, assignment and competency metadata from the pinned scenario version.

The historical Internal Audit, Data Analyst and Software Engineering demo packs remain non-qualifying. Their catalog projection is separated as **Practice internships** with explicit **Demo** and **Does not qualify for completion credentials** disclosure. Demo mode is not converted into standard mode and does not become a qualifying completion path.

### Publish-time scenario template inheritance

Versioned templates under `tutor/virtual-internship/templates/v1/` cover the standard 90-day knowledge-work rhythm, workplace communication, midpoint review, final review, completion disclosure and shared ethics-event patterns. `template_resolver.py` resolves explicitly pinned template versions at publish/validation time using deterministic schema-aware semantics. The resolved canonical scenario is validated and hashed; active internships read the immutable resolved scenario version rather than dynamically inheriting a mutable `latest` parent.

### Institution-created scenario workflow

Trusted institution/admin scenario creation is declarative and controlled. Drafts pass through the same template resolver and canonical validator as Murikah production packs, then through validated/published/retired lifecycle controls. Published versions are immutable, edits create a new version, learners cannot publish, and uploaded executable Python/JavaScript is not a scenario capability. Institution qualification does not bypass the 90-day, completion-policy, assessment/evidence, simulation-disclosure, demo-protection or physical-limitation invariants.

### API, UI and test surface

Phase 10 adds learner-safe catalog list/detail/facet reads, catalog projection/bootstrap support, exact-version start resolution, the marketplace/detail/commitment React surface, institution admin backend routes and the Phase 10 scenario/template validation modules. Catalog browse does not invoke Tutor models, actors, Mentor or assessor. Search/filter state is URL-backed, no-results is distinct from server/catalog failure, and practice/qualifying status is textual rather than color-only.

Regression coverage includes career families, catalog projection/search, exact-version start, practice protection, production-pack quality, scenario schemas/rubrics, template inheritance, institution workflow and frontend marketplace/commitment behavior. `tutor/cloudflare/preflight.py` validates packaging and Phase 10 release invariants in addition to the canonical scenario validator and Tutor preflight.

**Phase 11 longitudinal evaluation remains unimplemented.**

## SUBSEQUENT CAREER CATALOG DEVELOPMENT REQUIREMENT

Any later change to the Virtual Internship catalog, scenario publication, templates, production packs or institution workflow must preserve the Phase 1 through Phase 10 contracts. In particular, later work must not make the browser authoritative for qualification, silently advance a reviewed catalog item to a different scenario version, mutate a published scenario/template version in place, promote Practice/demo packs into qualifying internships, bypass the one-active-qualifying-internship rule, weaken completion/evidence gates, expose hidden scenario truth in catalog responses, or make active internships depend on mutable runtime template inheritance.

New career packs must be added through validated authored scenario metadata and the normalized catalog projection. New institution-created qualifying scenarios must use the same canonical validator, publish-time resolution, immutable snapshot/hash, completion policy and disclosure rules as Murikah-authored packs. Phase 11 longitudinal evaluation remains a separate future phase.
'''
    if "## Phase 10 Implementation Record" not in readme:
        readme = readme.rstrip() + record + "\n"
    write(readme_path, readme)

    legacy_path = "tutor/cloudflare/preflight_legacy.py"
    legacy = read(legacy_path).replace(
        '"Phase 10 career catalog remains unimplemented",',
        '"Phase 10 career catalog is implemented below",',
    )
    write(legacy_path, legacy)

    persistence_path = "tutor/cloudflare/PERSISTENCE.md"
    persistence = read(persistence_path)
    persistence_section = r'''

## Virtual Internship Phase 10 - career catalog, templates and institution publishing

Phase 10 keeps D1 authoritative for published catalog and scenario metadata. The authored, validated scenario manifest remains the source of truth; publication/bootstrap projects learner-safe searchable metadata into D1 rather than duplicating hidden scenario truth in the frontend.

Primary migration: `tutor/cloudflare/migrations/0016_virtual_internship_phase10_catalog.sql`.

Forward correction: `tutor/cloudflare/migrations/0017_virtual_internship_phase10_template_retirement_fix.sql`. This clears `retired_at` only for scenario template versions whose authoritative status is `published`; it does not rewrite the already-merged historical migration.

Phase 10 structures include:

- `career_families`, using stable family IDs/slugs and validated physical-competency classification;
- `internship_catalog_entries`, the normalized, indexed learner-safe projection for published/active/catalog-visible scenario versions;
- `scenario_templates` and `scenario_template_versions`, with stable IDs, explicit versions and immutable publish-time resolved content hashes;
- controlled institution scenario draft/publish state used by trusted admin/institution actors.

Catalog list/detail/facet routes expose only learner-safe metadata. Hidden facts, actor secrets, future events, rubrics and completion answer keys remain outside catalog DTOs. Ordinary catalog browse performs no R2 reads, model calls or scenario-runtime initialization.

Starting an internship still uses the Phase 1 start lifecycle and D1 ownership boundary. The selected catalog detail pins an exact `scenario_version_id`; the Worker revalidates authentication, membership, active-internship conflict, publication/catalog availability, authoritative qualification/mode, content hash and qualifying completion policy before creation. Browser values cannot set qualifying state, minimum duration or credential eligibility.

Template inheritance is resolved before immutable scenario publication. Runtime internships therefore depend on their fully resolved pinned scenario snapshot, not on a mutable parent template. Publishing a later parent template version does not retroactively alter existing scenario versions or internships.

Practice/demo catalog entries remain non-qualifying and cannot issue qualifying completion records. Institution-created scenarios use declarative data plus the same canonical resolver/validator and qualification invariants as Murikah production packs; executable uploaded code is not part of the scenario contract.
'''
    if "## Virtual Internship Phase 10" not in persistence:
        persistence = persistence.rstrip() + persistence_section + "\n"
    write(persistence_path, persistence)

    migration_path = ROOT / "tutor/cloudflare/migrations/0017_virtual_internship_phase10_template_retirement_fix.sql"
    if not migration_path.exists():
        migration_path.write_text(
            """-- Virtual Internship Phase 10 forward correction.\n-- 0016 populated retired_at for published template versions; published versions must not be retired.\nPRAGMA foreign_keys = ON;\n\nUPDATE scenario_template_versions\nSET retired_at = NULL\nWHERE status = 'published'\n  AND retired_at IS NOT NULL;\n""",
            encoding="utf-8",
        )

    regression_path = ROOT / "tutor/tests/test_virtual_internship_phase10_migration.py"
    if not regression_path.exists():
        regression_path.write_text(
            """from pathlib import Path\nimport unittest\n\n\nROOT = Path(__file__).resolve().parents[2]\n\n\nclass Phase10MigrationTests(unittest.TestCase):\n    def test_published_template_versions_are_not_left_retired(self):\n        sql = (ROOT / \"tutor/cloudflare/migrations/0017_virtual_internship_phase10_template_retirement_fix.sql\").read_text(encoding=\"utf-8\")\n        self.assertIn(\"UPDATE scenario_template_versions\", sql)\n        self.assertIn(\"SET retired_at = NULL\", sql)\n        self.assertIn(\"status = 'published'\", sql)\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n""",
            encoding="utf-8",
        )

elif MODE == "finalize":
    readme_path = "tutor/virtual-internship/README.md"
    readme = read(readme_path)
    checks = (
        "Career-family schema.",
        "Search/filter.",
        "Scenario template inheritance.",
        "Initial Internal Audit internship.",
        "Initial Data Analyst internship.",
        "Initial Software Engineering internship.",
        "Additional career packs.",
        "Physical-competency limitation labels.",
        "Institution-created scenario workflow.",
    )
    for label in checks:
        readme = readme.replace(f"- [ ] {label}", f"- [x] {label}", 1)
    readme = readme.replace(
        "Status: **implemented; release-gate verification is recorded by the focused Phase 10 branch.**",
        "Status: **implemented and closed after focused Phase 10 validation/preflight gates passed.**",
    )
    write(readme_path, readme)
else:
    raise SystemExit(f"unknown mode: {MODE}")
