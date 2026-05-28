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

    async def inspect_file(self, file_path: str) -> dict:
        model = await self.load_file(file_path)
        translation = await self.translate("traces")
        return {
            "model": model,
            "scopeSigs": translation.get("scopeSigs", []),
            "commandCount": translation.get("commandCount", 0),
        }

    def get_model(self) -> dict | None:
        return self.current_model

    async def translate(self, option: str = "traces") -> dict:
        return await self.bridge.send_command("translate", {"option": option})

    async def execute(self, cmd_idx: int = -1) -> dict:
        return await self.bridge.send_command("execute", {"cmdIdx": cmd_idx})

    async def init(self, sig_scopes: dict[str, int] | None = None) -> dict:
        params = {}
        if sig_scopes:
            params["sigScopes"] = sig_scopes
        return await self.bridge.send_command("init", params if params else None)

    async def next_solution(self) -> dict:
        return await self.bridge.send_command("next")

    async def step(self, state: dict,
                   sig_scopes: dict[str, int] | None = None) -> dict:
        # Step uses a single fixed scope on the Java side (exactly 2 __Snapshots);
        # no iterative scope search.
        params = {"state": state}
        if sig_scopes:
            params["sigScopes"] = sig_scopes
        return await self.bridge.send_command("step", params)
