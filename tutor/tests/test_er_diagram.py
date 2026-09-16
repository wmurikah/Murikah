"""Deterministic ER layout: model supplies data, renderer owns SVG syntax."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

source = Path(__file__).resolve().parents[1] / 'railway/murikah_er.py'
if not source.exists(): source = Path('/app/deeptutor/murikah_er.py')
spec = importlib.util.spec_from_file_location('er_under_test', source)
er = importlib.util.module_from_spec(spec)
spec.loader.exec_module(er)

# Representative model output fixture, never a production fallback/template.
FINANCE = {'title': 'Finance database', 'entities': [
    {'id': 'account', 'name': 'Account', 'fields': [{'name': 'account_id', 'type': 'uuid', 'key': 'PK'}, {'name': 'account_name', 'type': 'varchar(100)', 'key': ''}]},
    {'id': 'journal', 'name': 'Journal entry', 'fields': [{'name': 'entry_id', 'type': 'uuid', 'key': 'PK'}, {'name': 'posted_at', 'type': 'timestamp', 'key': ''}]},
    {'id': 'line', 'name': 'Journal line', 'fields': [{'name': 'line_id', 'type': 'uuid', 'key': 'PK'}, {'name': 'entry_id', 'type': 'uuid', 'key': 'FK'}, {'name': 'account_id', 'type': 'uuid', 'key': 'FK'}, {'name': 'debit', 'type': 'decimal(18,2)', 'key': ''}, {'name': 'credit', 'type': 'decimal(18,2)', 'key': ''}]},
], 'relationships': [
    {'from': 'account', 'to': 'line', 'from_field': 'account_id', 'to_field': 'account_id', 'cardinality': '1:N', 'label': 'has lines'},
    {'from': 'journal', 'to': 'line', 'from_field': 'entry_id', 'to_field': 'entry_id', 'cardinality': '1:N', 'label': 'contains'},
], 'assumptions': ['Illustrative double-entry ledger; enforce balanced entries in application/database logic.']}

class ERTests(unittest.TestCase):
    def test_auto_routes_exact_reported_prompt_and_explicit_type(self):
        self.assertTrue(er.uses_er_plan('Design ER diagram for a finance database'))
        self.assertTrue(er.uses_er_plan('Finance', 'er / data model'))
        self.assertTrue(er.uses_er_plan('Finance', 'database schema'))
        self.assertFalse(er.uses_er_plan('Database deployment topology', 'architecture'))
        self.assertFalse(er.uses_er_plan('Order to fulfilment'))

    def test_finance_plan_produces_complete_styled_svg_and_relationships(self):
        for style in ['editorial', 'minimal-light', 'minimal-dark']:
            fence = chr(96) * 3
            answer = er.er_answer(fence+'json\n'+json.dumps(FINANCE)+'\n'+fence, style)
            svg = re.search(r'<svg.*</svg>', answer, re.S).group(0)
            root = ET.fromstring(svg)
            self.assertTrue(root.get('viewBox'))
            texts = ''.join(root.itertext())
            for entity in FINANCE['entities']:
                self.assertIn(entity['name'], texts)
                for field in entity['fields']: self.assertIn(field['name'], texts)
            self.assertIn('Account.account_id', texts)
            self.assertIn('1:N', texts)
            self.assertIn('balanced entries', texts)
            self.assertNotIn('<script', svg)

    def test_special_characters_are_escaped_in_markup(self):
        plan = copy.deepcopy(FINANCE)
        plan['title'] = 'Finance & <Audit>'
        output = er.er_answer(json.dumps(plan))
        self.assertIn('Finance &amp; &lt;Audit&gt;', output)
        ET.fromstring(re.search(r'<svg.*</svg>', output, re.S).group(0))

    def test_rejects_truncated_plan_without_fabricating_schema(self):
        with self.assertRaises(er.InvalidERPlan): er.er_answer(json.dumps(FINANCE)[:-10])

    def test_rejects_unknown_entity_or_field(self):
        for key in ['to', 'to_field']:
            plan = copy.deepcopy(FINANCE)
            plan['relationships'][0][key] = 'nonexistent'
            with self.assertRaises(er.InvalidERPlan): er.er_answer(json.dumps(plan))

    def test_rejects_missing_primary_keys_and_oversized_plan(self):
        plan = copy.deepcopy(FINANCE)
        plan['entities'][0]['fields'][0]['key'] = ''
        with self.assertRaises(er.InvalidERPlan): er.er_answer(json.dumps(plan))
        plan = copy.deepcopy(FINANCE)
        plan['entities'] *= 4
        with self.assertRaises(er.InvalidERPlan): er.er_answer(json.dumps(plan))
