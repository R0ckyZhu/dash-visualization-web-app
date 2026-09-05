from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


def _positive_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _positive_float(name: str, default: float) -> float:
    try:
        return max(0.1, float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class LLMSettings:
    provider: str
    model: str
    api_key: Optional[str]
    base_url: Optional[str]
    request_timeout_seconds: float
    max_output_tokens: int
    max_tool_rounds: int
    history_message_limit: int

    @classmethod
    def from_env(cls) -> "LLMSettings":
        provider = os.environ.get("LLM_PROVIDER", "openai").strip().lower()
        return cls(
            provider=provider,
            model=os.environ.get("LLM_MODEL", "gpt-5-mini").strip(),
            api_key=(
                os.environ.get("LLM_API_KEY")
                or os.environ.get("OPENAI_API_KEY")
            ),
            base_url=os.environ.get("LLM_BASE_URL") or None,
            request_timeout_seconds=_positive_float(
                "LLM_REQUEST_TIMEOUT_SECONDS", 90.0
            ),
            max_output_tokens=_positive_int("LLM_MAX_OUTPUT_TOKENS", 1200),
            max_tool_rounds=_positive_int("LLM_MAX_TOOL_ROUNDS", 4),
            history_message_limit=_positive_int("LLM_HISTORY_MESSAGE_LIMIT", 16),
        )

    @property
    def enabled(self) -> bool:
        return self.provider == "openai" and bool(self.api_key and self.model)

    def public_metadata(self) -> dict:
        return {
            "enabled": self.enabled,
            "provider": self.provider,
            "model": self.model if self.enabled else None,
        }
