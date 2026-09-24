"""Phase 2 scenario JSON-schema, semantic validation and content-hash tests."""
from __future__ import annotations
import copy, json, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.validator import SCENARIOS_ROOT, ScenarioValidationError, content_hash, validate_all, validate_pack

class ScenarioSchemaTests(unittest.TestCase):
    def test_all_committed_career_neutral_demo_versions_validate(self):
        rows=validate_all()
        self.assertEqual(len(rows),6)
        self.assertEqual({p.name for p,_ in rows},{
            "internal-audit","internal-audit-v2",
            "data-analyst","data-analyst-v2",
            "software-engineering","software-engineering-v2",
        })
        for path,digest in rows:
            manifest=json.loads((path/"manifest.json").read_text())
            self.assertFalse(manifest["qualifying"])
            self.assertEqual(manifest["classification"],"demo")
            self.assertEqual(manifest["content_hash"],digest)
            self.assertGreaterEqual(manifest["minimum_duration_days"],90)

    def _mutate(self, pack_name, mutate):
        source=SCENARIOS_ROOT/"demo"/pack_name
        td=tempfile.TemporaryDirectory()
        target=Path(td.name)/pack_name
        shutil.copytree(source,target)
        mutate(target)
        return td,target

    def test_invalid_schema_version_duplicate_and_unknown_fields_rejected(self):
        for mutation in (
            lambda p: self._edit(p/"manifest.json",lambda x:x.__setitem__("schema_version",2)),
            lambda p: self._edit(p/"actors.json",lambda x:x.append(copy.deepcopy(x[0]))),
            lambda p: self._edit(p/"manifest.json",lambda x:x.__setitem__("surprise",True)),
        ):
            td,path=self._mutate("internal-audit",mutation)
            with td,self.assertRaises(ScenarioValidationError):validate_pack(path,verify_hash=False)

    def test_unknown_references_invalid_mutation_and_minimum_duration_rejected(self):
        cases=[
            lambda p:self._edit(p/"tasks.json",lambda x:x[1]["dependencies"].append("task_missing")),
            lambda p:self._edit(p/"actors.json",lambda x:x[0]["knowledge_fact_ids"].append("fact_missing")),
            lambda p:self._edit(p/"events.json",lambda x:x[0]["mutations"][0].__setitem__("mutation_type","rewrite_everything")),
            lambda p:self._edit(p/"manifest.json",lambda x:(x.__setitem__("classification","qualifying"),x.__setitem__("qualifying",True),x.__setitem__("minimum_duration_days",30))),
        ]
        for mutation in cases:
            td,path=self._mutate("internal-audit",mutation)
            with td,self.assertRaises(ScenarioValidationError):validate_pack(path,verify_hash=False)

    def test_task_and_event_cycles_are_rejected(self):
        td,path=self._mutate("internal-audit",lambda p:self._edit(p/"tasks.json",lambda x:x[0].__setitem__("dependencies",["task_draft_issue"])))
        with td,self.assertRaises(ScenarioValidationError):validate_pack(path,verify_hash=False)
        def event_cycle(p):
            def change(x):
                x[0]["triggers"]=[{"trigger_type":"prior_event","event_id":x[1]["event_id"]}]
                x[1]["triggers"]=[{"trigger_type":"prior_event","event_id":x[0]["event_id"]}]
            self._edit(p/"events.json",change)
        td,path=self._mutate("internal-audit",event_cycle)
        with td,self.assertRaises(ScenarioValidationError):validate_pack(path,verify_hash=False)

    def test_qualifying_final_review_cannot_precede_minimum_duration(self):
        def make_qualifying(path):
            def change(manifest):
                manifest["classification"]="qualifying"
                manifest["qualifying"]=True
                manifest["review_policy"]["final_review_day"]=85
            self._edit(path/"manifest.json",change)
        td,path=self._mutate("internal-audit-v2",make_qualifying)
        with td,self.assertRaisesRegex(ScenarioValidationError,"final_review_day"):
            validate_pack(path,verify_hash=False)

    def test_content_hash_is_key_order_independent_and_semantic_change_sensitive(self):
        pack=validate_pack(SCENARIOS_ROOT/"demo"/"internal-audit")
        reordered={key:pack[key] for key in reversed(list(pack.keys()))}
        reordered["manifest"]={key:pack["manifest"][key] for key in reversed(list(pack["manifest"].keys()))}
        self.assertEqual(content_hash(pack),content_hash(reordered))
        changed=copy.deepcopy(pack);changed["company"]["description"]+=" Changed."
        self.assertNotEqual(content_hash(pack),content_hash(changed))

    def test_hash_mismatch_is_rejected(self):
        td,path=self._mutate("data-analyst",lambda p:self._edit(p/"company.json",lambda x:x.__setitem__("description",x["description"]+" tampered")))
        with td,self.assertRaisesRegex(ScenarioValidationError,"content_hash"):validate_pack(path)

    def test_validator_command(self):
        run=subprocess.run([sys.executable,str(ROOT/"scripts/validate_virtual_internship_scenarios.py")],cwd=ROOT.parent,capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        self.assertIn("Virtual Internship Phase 2 scenario validation: PASS (6 packs)",run.stdout)

    @staticmethod
    def _edit(path,fn):
        value=json.loads(path.read_text());fn(value);path.write_text(json.dumps(value,indent=2)+"\n")

if __name__=="__main__":unittest.main()
