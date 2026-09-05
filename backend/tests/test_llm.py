from __future__ import annotations

import unittest

from app.llm.config import LLMSettings
from app.llm.context import build_instructions
from app.llm.schemas import (
    ChatRequest,
    ProviderRoundCompleted,
    ProviderTextDelta,
    ProviderToolCall,
)
from app.llm.service import ChatRevisionError, LLMService
from app.llm.tools import SessionToolRegistry
from app.session_context import SessionContextStore


class FakeProvider:
    name = "fake"
    model = "fake-model"

    def __init__(self, rounds):
        self.rounds = list(rounds)
        self.closed = False

    async def stream_round(self, **_kwargs):
        for event in self.rounds.pop(0):
            yield event

    async def close(self):
        self.closed = True


def settings():
    return LLMSettings(
        provider="openai",
        model="fake-model",
        api_key="test",
        base_url=None,
        request_timeout_seconds=5,
        max_output_tokens=200,
        max_tool_rounds=2,
        history_message_limit=8,
    )


def populated_store():
    store = SessionContextStore()
    store.replace_model(
        model={
            "rootName": "Counter",
            "states": [{"id": "Counter/Zero", "kind": "BASIC"}],
            "transitions": [{"id": "Counter/Zero/TurnOn"}],
            "events": [{"id": "Counter/click", "kind": "ENV"}],
            "vars": [{"id": "Counter/value", "kind": "INT"}],
            "buffers": [],
        },
        source_path="counter.dsh",
        dsh_source="secret complete source",
        alloy_source="secret translated alloy",
        operation="inspect",
    )
    store.update_ui_context(
        revision=1,
        state_tree={
            "nodes": [
                {
                    "id": 1,
                    "label": "S1",
                    "snapshot": {
                        "raw": {
                            "__conf2": ["Inner_0->Outer_1->Counter_Zero"],
                            "__taken2": [
                                "Inner_0->Outer_1->Counter_Zero_TurnOn"
                            ],
                        },
                        "activeStates": ["Counter/Zero"],
                        "takenTransitions": ["Counter/Zero/TurnOn"],
                    },
                }
            ],
            "edges": [],
        },
        trace_node_ids=[1],
        cursor_node_id=1,
        selection={"type": "snapshot", "id": 1},
        sig_scopes={"Inner": 2, "Outer": 2},
        simulation_mode="simplified",
        constraints=["some Counter_click"],
        tried_transitions_by_start={},
        shown_snapshots_by_start={},
    )
    return store


class LLMContextAndToolTests(unittest.TestCase):
    def test_compact_prompt_excludes_complete_source(self):
        prompt = build_instructions(populated_store().get())

        self.assertIn('"rootName": "Counter"', prompt)
        self.assertNotIn("secret complete source", prompt)
        self.assertNotIn("secret translated alloy", prompt)

    def test_snapshot_tool_preserves_parameter_tuple_columns(self):
        registry = SessionToolRegistry(populated_store().get())

        result = registry.execute("get_current_snapshot", "{}")

        self.assertIn(
            "Inner_0->Outer_1->Counter_Zero_TurnOn",
            str(result),
        )

    def test_all_tools_are_strict_and_disallow_extra_arguments(self):
        definitions = SessionToolRegistry(populated_store().get()).definitions()

        self.assertTrue(definitions)
        self.assertTrue(all(tool["strict"] for tool in definitions))
        self.assertTrue(
            all(tool["parameters"]["additionalProperties"] is False for tool in definitions)
        )


class LLMServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_round_streams_text_and_records_conversation(self):
        store = populated_store()
        provider = FakeProvider(
            [
                [
                    ProviderRoundCompleted(
                        response_id="response-1",
                        output_items=[
                            {
                                "type": "function_call",
                                "call_id": "call-1",
                                "name": "get_current_snapshot",
                                "arguments": "{}",
                            }
                        ],
                        tool_calls=[
                            ProviderToolCall(
                                call_id="call-1",
                                name="get_current_snapshot",
                                arguments="{}",
                            )
                        ],
                        usage={"inputTokens": 10, "outputTokens": 2, "totalTokens": 12},
                    )
                ],
                [
                    ProviderTextDelta(text="The current state is Zero."),
                    ProviderRoundCompleted(
                        response_id="response-2",
                        usage={"inputTokens": 15, "outputTokens": 6, "totalTokens": 21},
                    ),
                ],
            ]
        )
        service = LLMService(store, settings=settings(), provider=provider)
        request = ChatRequest(
            message="What is the current state?",
            conversationId="conversation-test",
            sessionRevision=1,
            cursorNodeId=1,
            selection={"type": "snapshot", "id": 1},
        )
        session = service.prepare("default", request)

        events = [event async for event in service.stream_chat(session, request)]

        self.assertEqual(events[0]["type"], "message.started")
        self.assertIn("tool.started", [event["type"] for event in events])
        self.assertIn("message.delta", [event["type"] for event in events])
        completed = events[-1]
        self.assertEqual(completed["type"], "message.completed")
        self.assertEqual(completed["usage"]["totalTokens"], 33)
        history = store.get().conversation
        self.assertEqual([item["role"] for item in history], ["user", "assistant"])
        self.assertEqual(history[-1]["text"], "The current state is Zero.")

    async def test_prepare_rejects_a_stale_revision(self):
        store = populated_store()
        service = LLMService(store, settings=settings(), provider=FakeProvider([]))
        request = ChatRequest(message="Explain", sessionRevision=0)

        with self.assertRaises(ChatRevisionError):
            service.prepare("default", request)


if __name__ == "__main__":
    unittest.main()
