from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .java_bridge import JavaBridge
from .session import SessionManager
from .session_context import SessionContextStore


class SessionCapacityError(RuntimeError):
    pass


@dataclass
class ManagedSession:
    id: str
    jar_path: str | Path
    bridge_factory: Callable[[str | Path], JavaBridge]
    last_access: float
    operation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    bridge: JavaBridge | None = None
    manager: SessionManager | None = None

    async def solver(self) -> SessionManager:
        if self.manager is not None:
            return self.manager
        bridge = self.bridge_factory(self.jar_path)
        await bridge.start()
        self.bridge = bridge
        self.manager = SessionManager(bridge)
        return self.manager

    async def stop(self) -> None:
        if self.bridge is not None:
            await self.bridge.stop()
        self.bridge = None
        self.manager = None


class SessionRegistry:
    """Owns one isolated Dash+/Alloy process per active browser session.

    Solver processes start lazily on the first model operation. Expired sessions
    are removed by the application cleanup loop, which also terminates the JVM.
    """

    def __init__(
        self,
        *,
        jar_path: str | Path,
        context_store: SessionContextStore,
        ttl_seconds: int = 3600,
        max_sessions: int = 16,
        bridge_factory: Callable[[str | Path], JavaBridge] = JavaBridge,
        clock: Callable[[], float] = time.monotonic,
    ):
        if ttl_seconds < 1:
            raise ValueError("ttl_seconds must be positive")
        if max_sessions < 1:
            raise ValueError("max_sessions must be positive")
        self.jar_path = jar_path
        self.context_store = context_store
        self.ttl_seconds = ttl_seconds
        self.max_sessions = max_sessions
        self.bridge_factory = bridge_factory
        self.clock = clock
        self._sessions: dict[str, ManagedSession] = {}
        self._lock = asyncio.Lock()

    async def create(self) -> ManagedSession:
        async with self._lock:
            await self._expire_locked()
            if len(self._sessions) >= self.max_sessions:
                raise SessionCapacityError(
                    "The demo is at its active-session limit. Try again shortly."
                )
            session_id = secrets.token_urlsafe(24)
            session = ManagedSession(
                id=session_id,
                jar_path=self.jar_path,
                bridge_factory=self.bridge_factory,
                last_access=self.clock(),
            )
            self._sessions[session_id] = session
            self.context_store.create(session_id)
            return session

    async def get(self, session_id: str) -> ManagedSession | None:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            if self.clock() - session.last_access >= self.ttl_seconds:
                if session.operation_lock.locked():
                    session.last_access = self.clock()
                    return session
                self._sessions.pop(session_id)
                self.context_store.delete(session_id)
                await session.stop()
                return None
            session.last_access = self.clock()
            return session

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
            self.context_store.delete(session_id)
            if session is not None:
                await session.stop()

    async def expire(self) -> int:
        async with self._lock:
            return await self._expire_locked()

    async def _expire_locked(self) -> int:
        now = self.clock()
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.last_access >= self.ttl_seconds
            and not session.operation_lock.locked()
        ]
        for session_id in expired:
            session = self._sessions.pop(session_id)
            self.context_store.delete(session_id)
            await session.stop()
        return len(expired)

    async def close(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            for session in sessions:
                self.context_store.delete(session.id)
                await session.stop()

    @property
    def count(self) -> int:
        return len(self._sessions)
