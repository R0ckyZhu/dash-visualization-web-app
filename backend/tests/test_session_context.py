from __future__ import annotations

import unittest

from app.session_context import SessionContextStore, StaleSessionRevisionError


class SessionContextStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = SessionContextStore()

    def test_model_replacement_increments_revision_and_clears_run_state(self):
        first = self.store.replace_model(
            model={"rootName": "First"},
            source_path="first.dsh",
            scope_sigs=["PID"],
            operation="inspect",
        )
        first_revision = first.revision
        self.store.record_solution(
            {"satisfiable": True, "snapshots": [{"__conf0": ["First_On"]}]},
            operation="init",
            sig_scopes={"PID": 2},
            constraints=["some event"],
            mode="raw",
        )
        self.store.update_ui_context(
            revision=2,
            state_tree={"nodes": [{"id": 1}], "edges": []},
            trace_node_ids=[1],
            cursor_node_id=1,
            selection={"type": "snapshot", "id": 1},
            sig_scopes={"PID": 2},
            simulation_mode="raw",
            constraints=["some event"],
            tried_transitions_by_start={"origin": ["PID_0->TurnOn"]},
            shown_snapshots_by_start={"origin": ["snapshot-key"]},
        )

        second = self.store.replace_model(
            model={"rootName": "Second"},
            source_path="second.dsh",
            operation="inspect",
        )

        self.assertEqual(first_revision, 1)
        self.assertEqual(second.revision, 3)
        self.assertEqual(second.snapshots, {})
        self.assertEqual(second.state_tree_nodes, [])
        self.assertEqual(second.trace_node_ids, [])
        self.assertIsNone(second.selection)
        self.assertEqual(second.constraints, [])

    def test_solution_records_inputs_origin_and_returned_snapshots(self):
        self.store.replace_model(
            model={"rootName": "Counter"},
            source_path="counter.dsh",
            operation="inspect",
        )
        context = self.store.record_solution(
            {
                "satisfiable": True,
                "snapshots": [
                    {"__conf1": ["PID_0->Counter_One"]},
                    {"__taken1": ["PID_0->Counter_OneToZero"]},
                ],
            },
            operation="alt-trans",
            sig_scopes={"PID": 2},
            constraints=["Counter_One in __webapp_conf[s]"],
            mode="simplified",
            origin_snapshot={"__conf1": ["PID_0->Counter_Zero"]},
        )

        self.assertEqual(context.revision, 2)
        self.assertEqual(context.last_operation, "alt-trans")
        self.assertEqual(context.sig_scopes, {"PID": 2})
        self.assertEqual(len(context.snapshots), 3)
        self.assertIn(
            "PID_0->Counter_OneToZero",
            str(context.latest_solution),
        )

    def test_ui_context_requires_current_revision(self):
        self.store.replace_model(
            model={"rootName": "TrafficLight"},
            source_path="traffic-light.dsh",
            operation="inspect",
        )

        with self.assertRaises(StaleSessionRevisionError) as raised:
            self.store.update_ui_context(
                revision=0,
                state_tree={"nodes": [{"id": 99}], "edges": []},
                trace_node_ids=[99],
                cursor_node_id=99,
                selection=None,
                sig_scopes={},
                simulation_mode="simplified",
                constraints=[],
                tried_transitions_by_start={},
                shown_snapshots_by_start={},
            )

        self.assertEqual(raised.exception.expected, 1)
        self.assertEqual(self.store.get().state_tree_nodes, [])

    def test_ui_context_adds_tree_snapshots_to_snapshot_index(self):
        self.store.replace_model(
            model={"rootName": "TrafficLight"},
            source_path="traffic-light.dsh",
            operation="inspect",
        )
        context = self.store.update_ui_context(
            revision=1,
            state_tree={
                "nodes": [
                    {
                        "id": 1,
                        "label": "S1",
                        "snapshot": {
                            "raw": {"__conf0": ["TrafficLight_Red"]}
                        },
                    }
                ],
                "edges": [],
            },
            trace_node_ids=[1],
            cursor_node_id=1,
            selection={"type": "snapshot", "id": 1},
            sig_scopes={},
            simulation_mode="simplified",
            constraints=[],
            tried_transitions_by_start={},
            shown_snapshots_by_start={},
        )

        self.assertEqual(context.cursor_node_id, 1)
        self.assertEqual(len(context.snapshots), 1)
        self.assertEqual(context.selection, {"type": "snapshot", "id": 1})


if __name__ == "__main__":
    unittest.main()
