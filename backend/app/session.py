from __future__ import annotations

from typing import Dict, List, Optional

from .java_bridge import JavaBridge


class SessionManager:
    def __init__(self, bridge: JavaBridge):
        self.bridge = bridge
        self.current_model: Optional[dict] = None
        self.current_file: Optional[str] = None
        self.current_translation: Optional[dict] = None

    async def load_file(self, file_path: str) -> dict:
        data = await self.bridge.send_command("load", {"filePath": file_path})
        self.current_model = data
        self.current_file = file_path
        self.current_translation = None
        return data

    async def inspect_file(self, file_path: str) -> dict:
        model = await self.load_file(file_path)
        translation = await self.translate("traces")
        return {
            "model": model,
            "scopeSigs": translation.get("scopeSigs", []),
            "commandCount": translation.get("commandCount", 0),
        }

    def get_model(self) -> Optional[dict]:
        return self.current_model

    async def translate(self, option: str = "traces") -> dict:
        data = await self.bridge.send_command("translate", {"option": option})
        self.current_translation = data
        return data

    async def execute(self, cmd_idx: int = -1) -> dict:
        return await self.bridge.send_command("execute", {"cmdIdx": cmd_idx})

    async def init(self, sig_scopes: Optional[Dict[str, int]] = None,
                   constraints: Optional[List[str]] = None,
                   extra_facts: Optional[List[str]] = None,
                   mode: Optional[str] = None) -> dict:
        params = {}
        if sig_scopes:
            params["sigScopes"] = sig_scopes
        if constraints:
            params["constraints"] = constraints
        if extra_facts:
            params["extraFacts"] = extra_facts
        if mode:
            params["mode"] = mode
        return await self.bridge.send_command("init", params if params else None)

    async def next_solution(self) -> dict:
        return await self.bridge.send_command("next")

    async def generated(self) -> dict:
        """The Alloy actually solved for the most recent init/step, plus its generated fragments."""
        return await self.bridge.send_command("generated")

    async def step(self, state: dict,
                   sig_scopes: Optional[Dict[str, int]] = None,
                   constraints: Optional[List[str]] = None,
                   extra_facts: Optional[List[str]] = None,
                   mode: Optional[str] = None,
                   exclude_transitions: Optional[List[str]] = None,
                   command: str = "step") -> dict:
        # Step uses a single fixed scope on the Java side (exactly 2 __Snapshots);
        # no iterative scope search. The "alt-trans" command reuses the same handler but
        # forces an untaken transition to fire.
        params = {"state": state}
        if sig_scopes:
            params["sigScopes"] = sig_scopes
        if constraints:
            params["constraints"] = constraints
        if extra_facts:
            params["extraFacts"] = extra_facts
        if mode:
            params["mode"] = mode
        if exclude_transitions:
            params["excludeTransitions"] = exclude_transitions
        return await self.bridge.send_command(command, params)
