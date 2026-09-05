from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    conversationId: Optional[str] = Field(default=None, max_length=128)
    sessionRevision: int = Field(ge=0)
    cursorNodeId: int | str | None = None
    selection: Optional[dict[str, Any]] = None


class ProviderToolCall(BaseModel):
    call_id: str
    name: str
    arguments: str


class ProviderTextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str


class ProviderRoundCompleted(BaseModel):
    type: Literal["round_completed"] = "round_completed"
    response_id: str
    output_items: list[dict[str, Any]] = Field(default_factory=list)
    tool_calls: list[ProviderToolCall] = Field(default_factory=list)
    usage: dict[str, int] = Field(default_factory=dict)


ProviderEvent = ProviderTextDelta | ProviderRoundCompleted
