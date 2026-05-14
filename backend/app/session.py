from .java_bridge import JavaBridge


class SessionManager:
    def __init__(self, bridge: JavaBridge):
        self.bridge = bridge
        self.current_model: dict | None = None
        self.current_file: str | None = None

    async def load_file(self, file_path: str) -> dict:
        data = await self.bridge.send_command("load", {"filePath": file_path})
        self.current_model = data
        self.current_file = file_path
        return data

    def get_model(self) -> dict | None:
        return self.current_model

    async def translate(self, option: str = "traces") -> dict:
        return await self.bridge.send_command("translate", {"option": option})

    async def execute(self, cmd_idx: int = -1) -> dict:
        return await self.bridge.send_command("execute", {"cmdIdx": cmd_idx})

    async def init(self) -> dict:
        return await self.bridge.send_command("init")

    async def next_solution(self) -> dict:
        return await self.bridge.send_command("next")

    async def step(self, init_state: dict, max_scope: int = 10) -> dict:
        return await self.bridge.send_command("step", {
            "initState": init_state,
            "maxScope": max_scope
        })
