import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .java_bridge import JavaBridge
from .models import ExecuteRequest, LoadRequest, StepRequest, TranslateRequest
from .session import SessionManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dash-viz")

JAR_PATH = os.environ.get(
    "DASHPLUS_JAR",
    str(
        Path(__file__).resolve().parent.parent.parent
        / "dashplus"
        / "app"
        / "build"
        / "libs"
        / "dashplus-session-server.jar"
    ),
)

bridge: JavaBridge | None = None
session: SessionManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global bridge, session
    bridge = JavaBridge(JAR_PATH)
    await bridge.start()
    session = SessionManager(bridge)
    yield
    await bridge.stop()


app = FastAPI(title="Dash Visualizer", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/load")
async def load_model(req: LoadRequest):
    try:
        data = await session.load_file(req.filePath)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/model")
async def get_model():
    model = session.get_model()
    if model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return model


@app.post("/api/translate")
async def translate_model(req: TranslateRequest):
    try:
        data = await session.translate(req.option)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/execute")
async def execute_command(req: ExecuteRequest):
    try:
        data = await session.execute(req.cmdIdx)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/init")
async def init_model():
    try:
        data = await session.init()
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/next")
async def next_solution():
    try:
        data = await session.next_solution()
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/step")
async def step(req: StepRequest):
    try:
        data = await session.step(req.initState, req.maxScope)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True))


def run():
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
