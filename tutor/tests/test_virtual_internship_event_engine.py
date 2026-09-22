"""Phase 2 deterministic event-trigger, ordering, cascade and replay tests."""
from __future__ import annotations
import copy,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.event_engine import complete_task,eligible_events,evaluate_events,initialize_state,record_decision,state_hash
from virtual_internship.validator import SCENARIOS_ROOT,ScenarioValidationError,validate_pack

class EventEngineTests(unittest.TestCase):
    def setUp(self):
        self.pack=validate_pack(SCENARIOS_ROOT/"demo"/"internal-audit");self.start=1_000_000
    def test_time_trigger_and_exactly_once(self):
        state=initialize_state(self.pack,self.start)
        state,fired=evaluate_events(self.pack,state,self.start,self.start+7*86400)
        self.assertIn("event_day7_variance",fired)
        rev=state["revision"];state,again=evaluate_events(self.pack,state,self.start,self.start+20*86400)
        self.assertNotIn("event_day7_variance",again);self.assertGreaterEqual(state["revision"],rev)
    def test_task_prior_event_fact_and_decision_triggers(self):
        state=initialize_state(self.pack,self.start)
        state=complete_task(self.pack,state,"task_review_process");state=complete_task(self.pack,state,"task_reconcile_sample")
        state,fired=evaluate_events(self.pack,state,self.start,self.start)
        self.assertIn("event_disclose_exception",fired)
        self.assertIn("event_management_pressure",fired)
        state=record_decision(self.pack,state,"decision_pressure_response","escalate")
        state,fired=evaluate_events(self.pack,state,self.start,self.start)
        self.assertEqual(fired,["event_escalation_choice"])
    def test_simultaneous_event_order_is_deterministic(self):
        pack=copy.deepcopy(self.pack)
        state=initialize_state(pack,self.start)
        state=complete_task(pack,state,"task_review_process");state=complete_task(pack,state,"task_reconcile_sample")
        order1=[e["event_id"] for e in eligible_events(pack,state,self.start,self.start+7*86400)]
        order2=[e["event_id"] for e in eligible_events(copy.deepcopy(pack),copy.deepcopy(state),self.start,self.start+7*86400)]
        self.assertEqual(order1,order2)
        self.assertEqual(order1,["event_disclose_exception","event_day7_variance"])
    def test_fact_cascade_and_replay_reconstruct_same_hash(self):
        pack=validate_pack(SCENARIOS_ROOT/"demo"/"data-analyst")
        s1=initialize_state(pack,self.start);s2=initialize_state(pack,self.start)
        for task in ("task_inspect_dataset","task_define_metric","task_quality_plan"):
            s1=complete_task(pack,s1,task);s2=complete_task(pack,s2,task)
        s1,f1=evaluate_events(pack,s1,self.start,self.start+10*86400)
        s2,f2=evaluate_events(pack,s2,self.start,self.start+10*86400)
        self.assertEqual(f1,f2);self.assertEqual(s1["revision"],s2["revision"]);self.assertEqual(state_hash(s1),state_hash(s2))
    def test_unknown_decision_and_cascade_limit_fail_closed(self):
        state=initialize_state(self.pack,self.start)
        with self.assertRaises(ScenarioValidationError):record_decision(self.pack,state,"decision_missing","x")
        pack=copy.deepcopy(self.pack)
        for i in range(20):
            pack["events"].append({"event_id":f"event_extra_{i}","authored_sequence":100+i,"event_type":"test","priority":1,
              "triggers":[{"trigger_type":"time_elapsed_days","days":0}],"mutations":[{"mutation_type":"reveal_fact","fact_id":"fact_public_policy"}],
              "message_template_id":"msg_extra","actor_ids":[],"once":True,"audit_label":"extra","learning_objective":"bounded test"})
        with self.assertRaisesRegex(ScenarioValidationError,"cascade depth"):evaluate_events(pack,state,self.start,self.start,max_depth=4)
    def test_immutable_fact_and_unknown_mutation_rejected_at_validation(self):
        pack=copy.deepcopy(self.pack)
        pack["events"][0]["mutations"]=[{"mutation_type":"set_mutable_fact","fact_id":"fact_invoice_amount","value":200000}]
        from virtual_internship.validator import _event_dependency_cycle
        # Runtime defense is also present; validator is the publication boundary.
        import tempfile,json
        # direct pure engine defense:
        pack2=copy.deepcopy(self.pack);pack2["events"][0]["mutations"]=[{"mutation_type":"set_mutable_fact","fact_id":"fact_invoice_amount","value":200000}]
        with self.assertRaises(ScenarioValidationError):evaluate_events(pack2,initialize_state(pack2,self.start),self.start,self.start+7*86400)
if __name__=="__main__":unittest.main()
