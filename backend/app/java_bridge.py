import asyncio
import json
import logging
import subprocess
import uuid
from pathlib import Path

logger = logging.getLogger("dash-viz.java-bridge")


class JavaBridge:
    def __init__(self, jar_path: str | Path):
        self.jar_path = Path(jar_path)
        self._process: subprocess.Popen | None = None
        self._lock = asyncio.Lock()
        self._stderr_task: asyncio.Task | None = None

    async def start(self):
        if self._process and self._process.poll() is None:
            return

        logger.info("Starting SessionServer: %s", self.jar_path)
        self._process = subprocess.Popen(
            ["java", "-jar", str(self.jar_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        self._stderr_task = asyncio.create_task(self._drain_stderr())

        loop = asyncio.get_event_loop()
        ready_line = await loop.run_in_executor(None, self._process.stdout.readline)
        ready = json.loads(ready_line)
        if ready.get("status") != "ready":
            raise RuntimeError(f"SessionServer did not send ready signal: {ready_line}")
        logger.info("SessionServer ready")

    async def _drain_stderr(self):
        loop = asyncio.get_event_loop()
        while self._process and self._process.poll() is None:
            try:
                line = await loop.run_in_executor(None, self._process.stderr.readline)
                if line:
                    logger.debug("[java] %s", line.rstrip())
                else:
                    break
            except Exception:
                break

    async def send_command(self, command: str, params: dict | None = None) -> dict:
        if not self._process or self._process.poll() is not None:
            raise RuntimeError("SessionServer is not running")

        async with self._lock:
            request = {
                "id": str(uuid.uuid4())[:8],
                "command": command,
            }
            if params:
                request["params"] = params

            loop = asyncio.get_event_loop()

            def _do_io():
                self._process.stdin.write(json.dumps(request) + "\n")
                self._process.stdin.flush()
                return self._process.stdout.readline()

            response_line = await loop.run_in_executor(None, _do_io)
            if not response_line:
                raise RuntimeError("SessionServer returned empty response")

            response = json.loads(response_line)
            if response.get("status") == "error":
                raise RuntimeError(response.get("error", "Unknown error"))

            return response.get("data", {})

    async def stop(self):
        if not self._process:
            return
        try:
            await self.send_command("quit")
        except Exception:
            pass
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()
        if self._stderr_task:
            self._stderr_task.cancel()
        self._process = None
        logger.info("SessionServer stopped")
