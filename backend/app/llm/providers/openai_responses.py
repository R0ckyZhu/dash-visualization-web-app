from __future__ import annotations

from typing import Any, AsyncIterator

from openai import APIError, APITimeoutError, AsyncOpenAI

from ..config import LLMSettings
from ..provider import LLMProviderError
from ..schemas import (
    ProviderEvent,
    ProviderRoundCompleted,
    ProviderTextDelta,
    ProviderToolCall,
)


class OpenAIResponsesProvider:
    def __init__(self, settings: LLMSettings):
        if not settings.api_key:
            raise ValueError("An API key is required for the OpenAI provider")
        options: dict[str, Any] = {
            "api_key": settings.api_key,
            "timeout": settings.request_timeout_seconds,
        }
        if settings.base_url:
            options["base_url"] = settings.base_url
        self._client = AsyncOpenAI(**options)
        self._model = settings.model
        self._max_output_tokens = settings.max_output_tokens

    @property
    def name(self) -> str:
        return "openai"

    @property
    def model(self) -> str:
        return self._model

    async def stream_round(
        self,
        *,
        instructions: str,
        input_items: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AsyncIterator[ProviderEvent]:
        stream = None
        completed_response = None
        try:
            stream = await self._client.responses.create(
                model=self._model,
                instructions=instructions,
                input=input_items,
                include=["reasoning.encrypted_content"],
                tools=tools,
                tool_choice="auto",
                parallel_tool_calls=False,
                max_output_tokens=self._max_output_tokens,
                store=False,
                stream=True,
                truncation="auto",
            )
            async for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "response.output_text.delta":
                    yield ProviderTextDelta(text=event.delta)
                elif event_type == "response.completed":
                    completed_response = event.response
                elif event_type in {"response.failed", "response.incomplete"}:
                    response = getattr(event, "response", None)
                    error = getattr(response, "error", None)
                    incomplete_details = getattr(response, "incomplete_details", None)
                    reason = getattr(incomplete_details, "reason", None)
                    message = getattr(error, "message", None)
                    if not message and reason:
                        message = f"The LLM response was incomplete: {reason}"
                    message = message or event_type
                    raise LLMProviderError(str(message))
        except APITimeoutError as exc:
            raise LLMProviderError("The LLM provider timed out") from exc
        except APIError as exc:
            message = getattr(exc, "message", None) or str(exc)
            raise LLMProviderError(f"The LLM provider rejected the request: {message}") from exc
        finally:
            if stream is not None:
                await stream.close()

        if completed_response is None:
            raise LLMProviderError("The LLM provider ended without a completed response")

        output_items = [
            item.model_dump(mode="json", by_alias=True, exclude_none=True)
            for item in completed_response.output
        ]
        tool_calls = [
            ProviderToolCall(
                call_id=item.call_id,
                name=item.name,
                arguments=item.arguments,
            )
            for item in completed_response.output
            if getattr(item, "type", None) == "function_call"
        ]
        usage = completed_response.usage
        yield ProviderRoundCompleted(
            response_id=completed_response.id,
            output_items=output_items,
            tool_calls=tool_calls,
            usage={
                "inputTokens": getattr(usage, "input_tokens", 0) if usage else 0,
                "outputTokens": getattr(usage, "output_tokens", 0) if usage else 0,
                "totalTokens": getattr(usage, "total_tokens", 0) if usage else 0,
            },
        )

    async def close(self) -> None:
        await self._client.close()
