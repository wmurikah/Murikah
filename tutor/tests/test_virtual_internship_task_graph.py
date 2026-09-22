"""Phase 2 deterministic task-graph tests."""
from __future__ import annotations
import copy,json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.task_graph import initial_task_states,transition_task,unlock_satisfied
from virtual_internship.validator import SCENARIOS_ROOT,ScenarioValidationError,topological_task_order,validate_pack

class TaskGraphTests(unittest.TestCase):
    def setUp(self):self.pack=validate_pack(SCENARIOS_ROOT/"demo"/"internal-audit")
    def test_chain_unlocks_deterministically(self):
        tasks=self.pack["tasks"];states=initial_task_states(tasks)
        self.assertEqual(states["task_review_process"],"available")
        self.assertEqual(states["task_reconcile_sample"],"locked")
        states=transition_task(states,"task_review_process","in_progress");states=transition_task(states,"task_review_process","completed")
        states,unlocked=unlock_satisfied(tasks,states);self.assertEqual(unlocked,["task_reconcile_sample"]);self.assertEqual(states["task_investigate_variance"],"locked")
        states=transition_task(states,"task_reconcile_sample","in_progress");states=transition_task(states,"task_reconcile_sample","completed")
        states,unlocked=unlock_satisfied(tasks,states);self.assertEqual(unlocked,["task_investigate_variance"])
    def test_multiple_dependencies_require_all(self):
        tasks=[
          {"task_id":"task_a","dependencies":[],"authored_sequence":1},
          {"task_id":"task_b","dependencies":[],"authored_sequence":2},
          {"task_id":"task_c","dependencies":["task_a","task_b"],"authored_sequence":3},
        ]
        states=initial_task_states(tasks);states["task_a"]="completed"
        states,unlocked=unlock_satisfied(tasks,states);self.assertEqual(unlocked,[])
        states["task_b"]="completed";states,unlocked=unlock_satisfied(tasks,states);self.assertEqual(unlocked,["task_c"])
    def test_topological_order_stable_and_invalid_transition_rejected(self):
        first=topological_task_order(self.pack["tasks"]);second=topological_task_order(copy.deepcopy(self.pack["tasks"]))
        self.assertEqual(first,second)
        with self.assertRaises(ScenarioValidationError):transition_task(initial_task_states(self.pack["tasks"]),"task_reconcile_sample","completed")
    def test_cycle_missing_and_self_dependency_rejected(self):
        for tasks in (
          [{"task_id":"task_a","dependencies":["task_b"],"authored_sequence":1},{"task_id":"task_b","dependencies":["task_a"],"authored_sequence":2}],
          [{"task_id":"task_a","dependencies":["task_z"],"authored_sequence":1}],
          [{"task_id":"task_a","dependencies":["task_a"],"authored_sequence":1}],
        ):
            with self.assertRaises(ScenarioValidationError):topological_task_order(tasks)
if __name__=="__main__":unittest.main()
