from __future__ import annotations

import unittest

from app.session_context import SessionContextStore, SessionNotFoundError
from app.session_registry import SessionCapacityError, SessionRegistry


class FakeBridge:
    instances: list["FakeBridge"] = []

    def __init__(self, jar_path):
        self.jar_path = jar_path
        self.started = False
        self.stopped = False
        self.__class__.instances.append(self)

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True


class SessionRegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeBridge.instances = []
        self.now = 100.0
        self.store = SessionContextStore()
        self.registry = SessionRegistry(
            jar_path="test.jar",
            context_store=self.store,
            ttl_seconds=10,
            max_sessions=2,
            bridge_factory=FakeBridge,
            clock=lambda: self.now,
        )

    async def asyncTearDown(self):
        await self.registry.close()

    async def test_sessions_are_isolated_and_solver_processes_are_lazy(self):
        first = await self.registry.create()
        second = await self.registry.create()

        self.assertNotEqual(first.id, second.id)
        self.assertEqual(FakeBridge.instances, [])
        self.store.replace_model(
            model={"rootName": "First"},
            source_path="first.dsh",
            operation="inspect",
            session_id=first.id,
        )
        self.assertIsNone(self.store.get(second.id).model)

        await first.solver()
        self.assertEqual(len(FakeBridge.instances), 1)
        self.assertTrue(FakeBridge.instances[0].started)

    async def test_expiry_stops_solver_and_removes_context(self):
        session = await self.registry.create()
        await session.solver()
        self.now += 11

        self.assertEqual(await self.registry.expire(), 1)
        self.assertTrue(FakeBridge.instances[0].stopped)
        self.assertIsNone(await self.registry.get(session.id))
        with self.assertRaises(SessionNotFoundError):
            self.store.get(session.id)

    async def test_capacity_is_enforced(self):
        await self.registry.create()
        await self.registry.create()
        with self.assertRaises(SessionCapacityError):
            await self.registry.create()


if __name__ == "__main__":
    unittest.main()
