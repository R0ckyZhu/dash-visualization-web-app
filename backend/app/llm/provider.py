from __future__ import annotations

from typing import Any, AsyncIterator, Protocol

from .schemas import ProviderEvent


class LLMProviderError(RuntimeError):
    pass


class LLMProvider(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...

    def stream_round(
        self,
        *,
        instructions: str,
        input_items: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AsyncIterator[ProviderEvent]: ...

    async def close(self) -> None: ...
