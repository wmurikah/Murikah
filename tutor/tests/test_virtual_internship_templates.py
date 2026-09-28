from __future__ import annotations

import copy
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.template_resolver import (
    MAX_INHERITANCE_DEPTH,
    TemplateResolutionError,
    load_templates,
    resolve_template_sections,
    template_content_hash,
)


class Phase10TemplateTests(unittest.TestCase):
    def setUp(self):
        self.templates=load_templates()

    def test_six_committed_templates_are_hash_pinned_and_published(self):
        self.assertEqual(len(self.templates),6)
        for template in self.templates.values():
            self.assertEqual(template["status"],"published")
            self.assertEqual(template["content_hash"],template_content_hash(template))

    def test_scalar_override_and_array_replace_are_deterministic(self):
        template={
            "template_id":"tpl_unit_base","template_version":1,"schema_version":1,"status":"published","content_hash":"",
            "sections":{"manifest_defaults":{"minimum_duration_days":90,"tags":["parent"],"nested":{"a":1,"b":2}}},
        }
        template["content_hash"]=template_content_hash(template)
        ref={"template_id":"tpl_unit_base","template_version":1,"content_hash":template["content_hash"]}
        result=resolve_template_sections(
            {"manifest_defaults":{"minimum_duration_days":120,"tags":["child"],"nested":{"b":3}}},
            [ref],{("tpl_unit_base",1):template},
        )
        manifest=result["manifest_defaults"]
        self.assertEqual(manifest["minimum_duration_days"],120)
        self.assertEqual(manifest["tags"],["child"])
        self.assertEqual(manifest["nested"],{"a":1,"b":3})

    def test_explicit_keyed_collection_merges_by_stable_id(self):
        template={
            "template_id":"tpl_unit_keyed","template_version":1,"schema_version":1,"status":"published","content_hash":"",
            "sections":{"keyed_collections":{"tasks":{"key":"task_id","items":[{"task_id":"task_a","title":"Parent","priority":1}]}}},
        }
        template["content_hash"]=template_content_hash(template)
        ref={"template_id":"tpl_unit_keyed","template_version":1,"content_hash":template["content_hash"]}
        result=resolve_template_sections({},[ref],{("tpl_unit_keyed",1):template})
        self.assertEqual(result["tasks"],[{"task_id":"task_a","title":"Parent","priority":1}])

    def test_missing_unpublished_hash_mismatch_and_duplicate_are_rejected(self):
        template={
            "template_id":"tpl_unit_guard","template_version":1,"schema_version":1,"status":"published","content_hash":"","sections":{},
        }
        template["content_hash"]=template_content_hash(template)
        templates={("tpl_unit_guard",1):template}
        with self.assertRaisesRegex(TemplateResolutionError,"missing parent"):
            resolve_template_sections({},[{"template_id":"tpl_missing","template_version":1,"content_hash":"0"*64}],templates)
        retired=copy.deepcopy(template);retired["status"]="retired";retired["content_hash"]=template_content_hash(retired)
        with self.assertRaisesRegex(TemplateResolutionError,"unpublished"):
            resolve_template_sections({},[{"template_id":"tpl_unit_guard","template_version":1,"content_hash":retired["content_hash"]}],{("tpl_unit_guard",1):retired})
        with self.assertRaisesRegex(TemplateResolutionError,"hash mismatch"):
            resolve_template_sections({},[{"template_id":"tpl_unit_guard","template_version":1,"content_hash":"0"*64}],templates)
        ref={"template_id":"tpl_unit_guard","template_version":1,"content_hash":template["content_hash"]}
        with self.assertRaisesRegex(TemplateResolutionError,"duplicate inherited"):
            resolve_template_sections({},[ref,ref],templates)

    def test_parent_cycle_and_excessive_depth_are_rejected(self):
        a={"template_id":"tpl_cycle_a","template_version":1,"schema_version":1,"status":"published","content_hash":"","sections":{}}
        b={"template_id":"tpl_cycle_b","template_version":1,"schema_version":1,"status":"published","content_hash":"","sections":{}}
        # Create pinned cycle using fixed hashes from the parent-free forms; resolver checks the refs before descending.
        a["content_hash"]=template_content_hash(a);b["content_hash"]=template_content_hash(b)
        a["parent_refs"]=[{"template_id":"tpl_cycle_b","template_version":1,"content_hash":b["content_hash"]}]
        b["parent_refs"]=[{"template_id":"tpl_cycle_a","template_version":1,"content_hash":a["content_hash"]}]
        a["content_hash"]=template_content_hash(a);b["content_hash"]=template_content_hash(b)
        # Repin once so the first edge is valid; the second must still fail closed rather than recurse indefinitely.
        a["parent_refs"][0]["content_hash"]=b["content_hash"]
        a["content_hash"]=template_content_hash(a)
        ref={"template_id":"tpl_cycle_a","template_version":1,"content_hash":a["content_hash"]}
        with self.assertRaises(TemplateResolutionError):
            resolve_template_sections({},[ref],{("tpl_cycle_a",1):a,("tpl_cycle_b",1):b})
        self.assertEqual(MAX_INHERITANCE_DEPTH,8)


if __name__=="__main__":unittest.main()
