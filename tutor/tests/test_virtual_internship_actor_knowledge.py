"""Phase 2 actor and learner knowledge-boundary tests."""
from __future__ import annotations
import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.knowledge import actor_fact_view,initial_runtime_facts,learner_fact_view
from virtual_internship.event_engine import complete_task,evaluate_events,initialize_state
from virtual_internship.validator import SCENARIOS_ROOT,validate_pack

class ActorKnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.pack=validate_pack(SCENARIOS_ROOT/"demo"/"internal-audit")
        self.facts=initial_runtime_facts(self.pack)
    def test_supervisor_peer_vendor_matrix(self):
        supervisor=actor_fact_view(self.pack,self.facts,"actor_audit_supervisor")
        peer=actor_fact_view(self.pack,self.facts,"actor_peer_intern")
        vendor=actor_fact_view(self.pack,self.facts,"actor_vendor_rep")
        self.assertIn("fact_manager_note",supervisor);self.assertNotIn("fact_vendor_contract",supervisor)
        self.assertIn("fact_team_procedure",peer);self.assertNotIn("fact_manager_note",peer)
        self.assertIn("fact_vendor_contract",vendor);self.assertNotIn("fact_team_procedure",vendor)
        for view in (supervisor,peer,vendor):
            self.assertNotIn("fact_future_request",view);self.assertNotIn("fact_control_exception",view)
    def test_learner_hidden_truth_is_revealed_only_by_authored_event(self):
        state=initialize_state(self.pack,1_000_000)
        learner=learner_fact_view(self.pack,state["facts"])
        self.assertNotIn("fact_control_exception",learner)
        state=complete_task(self.pack,state,"task_review_process")
        state=complete_task(self.pack,state,"task_reconcile_sample")
        state,fired=evaluate_events(self.pack,state,1_000_000,1_000_000)
        self.assertIn("event_disclose_exception",fired)
        self.assertIn("event_management_pressure",fired)
        learner=learner_fact_view(self.pack,state["facts"])
        self.assertIn("fact_control_exception",learner)
        self.assertIn("fact_future_request",learner)
    def test_private_actor_fact_can_be_known_without_leaking_to_learner(self):
        pack=validate_pack(SCENARIOS_ROOT/"demo"/"data-analyst")
        facts=initial_runtime_facts(pack)
        engineer=actor_fact_view(pack,facts,"actor_data_engineer")
        learner=learner_fact_view(pack,facts)
        self.assertIn("fact_hidden_null_issue",engineer)
        self.assertNotIn("fact_hidden_null_issue",learner)

    def test_future_event_fact_does_not_leak_merely_because_pack_contains_it(self):
        for actor in [a["actor_id"] for a in self.pack["actors"]]:
            self.assertNotIn("fact_future_request",actor_fact_view(self.pack,self.facts,actor))
        self.assertNotIn("fact_future_request",learner_fact_view(self.pack,self.facts))
if __name__=="__main__":unittest.main()
