from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from typing import Any, AsyncIterator, Optional

from ..session_context import AppSessionContext, SessionContextStore
from .config import LLMSettings
from .context import build_instructions
from .provider import LLMProvider, LLMProviderError
from .providers import OpenAIResponsesProvider
from .schemas import ChatRequest, ProviderRoundCompleted, ProviderTextDelta
from .tools import SessionToolRegistry, ToolExecutionError


class LLMNotConfiguredError(RuntimeError):
    pass


class ModelContextRequiredError(RuntimeError):
    pass


class ChatRevisionError(ValueError):
    def __init__(self, expected: int, received: int):
        self.expected = expected
        self.received = received
        super().__init__(
            f"The simulation changed before this question was sent "
            f"(expected revision {expected}, received {received})"
        )


class LLMService:
    def __init__(
        self,
        context_store: SessionContextStore,
        settings: Optional[LLMSettings] = None,
        provider: Optional[LLMProvider] = None,
    ):
        self.context_store = context_store
        self.settings = settings or LLMSettings.from_env()
        self.provider = provider or self._configured_provider()
        self._session_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def _configured_provider(self) -> Optional[LLMProvider]:
        if not self.settings.enabled:
            return None
        if self.settings.provider == "openai":
            return OpenAIResponsesProvider(self.settings)
        return None

    @property
    def enabled(self) -> bool:
        return self.provider is not None

    def capabilities(self) -> dict[str, Any]:
        registry = SessionToolRegistry(AppSessionContext(id="capabilities"))
        return {
            **self.settings.public_metadata(),
            "streaming": True,
            "readOnly": True,
            "tools": [tool["name"] for tool in registry.definitions()],
        }

    def prepare(self, session_id: str, request: ChatRequest) -> AppSessionContext:
        if not self.enabled:
            raise LLMNotConfiguredError(
                "The assistant is not configured. Set LLM_API_KEY (or "
                "OPENAI_API_KEY), then restart the backend."
            )
        session = self.context_store.snapshot(session_id)
        if session.model is None:
            raise ModelContextRequiredError("Load a model before asking the assistant.")
        if request.sessionRevision != session.revision:
            raise ChatRevisionError(session.revision, request.sessionRevision)
        if request.cursorNodeId is not None:
            session.cursor_node_id = request.cursorNodeId
        if request.selection is not None:
            session.selection = request.selection
        return session

    async def stream_chat(
        self,
        session: AppSessionContext,
        request: ChatRequest,
    ) -> AsyncIterator[dict[str, Any]]:
        if self.provider is None:
            raise LLMNotConfiguredError("The assistant is not configured")

        conversation_id = request.conversationId or f"conversation-{uuid.uuid4()}"
        message_id = f"message-{uuid.uuid4()}"
        based_revision = session.revision
        registry = SessionToolRegistry(session)
        input_items = self._conversation_input(session, conversation_id)
        input_items.append({"role": "user", "content": request.message})
        instructions = build_instructions(session)
        answer_parts: list[str] = []
        usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}

        self.context_store.append_conversation_message(
            session_id=session.id,
            conversation_id=conversation_id,
            role="user",
            text=request.message,
            session_revision=based_revision,
        )

        yield {
            "type": "message.started",
            "conversationId": conversation_id,
            "messageId": message_id,
            "sessionRevision": based_revision,
            "model": self.provider.model,
        }

        async with self._session_locks[session.id]:
            for round_index in range(self.settings.max_tool_rounds + 1):
                completed: ProviderRoundCompleted | None = None
                async for event in self.provider.stream_round(
                    instructions=instructions,
                    input_items=input_items,
                    tools=registry.definitions(),
                ):
                    if isinstance(event, ProviderTextDelta):
                        answer_parts.append(event.text)
                        yield {
                            "type": "message.delta",
                            "messageId": message_id,
                            "delta": event.text,
                        }
                    elif isinstance(event, ProviderRoundCompleted):
                        completed = event

                if completed is None:
                    raise LLMProviderError("The provider returned no completion event")
                for key in usage:
                    usage[key] += completed.usage.get(key, 0)

                if not completed.tool_calls:
                    break
                if round_index >= self.settings.max_tool_rounds:
                    raise LLMProviderError("The assistant exceeded its tool-call limit")

                input_items.extend(completed.output_items)
                for call in completed.tool_calls:
                    yield {
                        "type": "tool.started",
                        "messageId": message_id,
                        "tool": call.name,
                    }
                    succeeded = True
                    try:
                        result = registry.execute(call.name, call.arguments)
                    except ToolExecutionError as exc:
                        succeeded = False
                        result = {"error": str(exc)}
                    serialized = self._serialize_tool_result(result)
                    input_items.append(
                        {
                            "type": "function_call_output",
                            "call_id": call.call_id,
                            "output": serialized,
                        }
                    )
                    yield {
                        "type": "tool.completed",
                        "messageId": message_id,
                        "tool": call.name,
                        "succeeded": succeeded,
                    }

        answer = "".join(answer_parts).strip()
        if not answer:
            answer = "The assistant completed without returning text."
            yield {
                "type": "message.delta",
                "messageId": message_id,
                "delta": answer,
            }

        self.context_store.append_conversation_message(
            session_id=session.id,
            conversation_id=conversation_id,
            role="assistant",
            text=answer,
            session_revision=based_revision,
        )
        current_revision = self.context_store.get(session.id).revision
        references = [session.selection] if session.selection else []
        yield {
            "type": "message.completed",
            "conversationId": conversation_id,
            "messageId": message_id,
            "sessionRevision": based_revision,
            "currentSessionRevision": current_revision,
            "stale": current_revision != based_revision,
            "usage": usage,
            "references": references,
        }

    def _conversation_input(
        self,
        session: AppSessionContext,
        conversation_id: str,
    ) -> list[dict[str, str]]:
        messages = [
            item
            for item in session.conversation
            if item.get("conversationId") == conversation_id
            and item.get("role") in {"user", "assistant"}
            and isinstance(item.get("text"), str)
        ][-self.settings.history_message_limit :]
        return [
            {"role": item["role"], "content": item["text"]}
            for item in messages
        ]

    @staticmethod
    def _serialize_tool_result(result: Any) -> str:
        text = json.dumps(result, ensure_ascii=True, default=str)
        max_chars = 120_000
        if len(text) <= max_chars:
            return text
        return json.dumps(
            {
                "truncated": True,
                "originalCharacters": len(text),
                "preview": text[:max_chars],
            },
            ensure_ascii=True,
        )

    async def close(self) -> None:
        if self.provider is not None:
            await self.provider.close()
