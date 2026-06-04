import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .java_bridge import JavaBridge
from .models import ExecuteRequest, InitRequest, InspectRequest, LoadRequest, StepRequest, TranslateRequest
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


EXAMPLES_DIR = Path(__file__).resolve().parent.parent / "examples"

# Pretty labels for the collection folders.
_GROUP_LABELS = {
    "2019-dash-website": "2019 · dash-website",
    "2022-bandali-thesis": "2022 · bandali-thesis",
    "2022-tamjid-thesis": "2022 · tamjid-thesis",
    "2023-bandali-day-paper": "2023 · bandali-day-paper",
    "local-models": "Local models",
}


@app.get("/api/examples")
async def list_examples():
    """Scan backend/examples for bundled case-study .dsh files, grouped by collection."""
    if not EXAMPLES_DIR.exists():
        return {"examples": []}

    items = []
    for dsh in sorted(EXAMPLES_DIR.rglob("*.dsh")):
        rel = dsh.relative_to(EXAMPLES_DIR)
        group = rel.parts[0]
        folder = dsh.parent
        siblings = list(folder.glob("*.dsh"))
        # If a folder holds several models (e.g. landing-gear ref0..ref4) keep the
        # file stem to disambiguate; otherwise the folder name is the model name.
        if len(siblings) > 1:
            name = f"{folder.name}/{dsh.stem}"
        else:
            name = folder.name
        items.append(
            {
                "group": _GROUP_LABELS.get(group, group),
                "name": name,
                "path": str(dsh),
            }
        )
    return {"examples": items}


@app.get("/api/source")
async def get_source():
    """Return the loaded model's raw .dsh text and its translated .als (Alloy) code."""
    if session is None or session.current_file is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    try:
        dsh_text = Path(session.current_file).read_text(encoding="utf-8")
    except OSError as e:
        dsh_text = f"// Could not read source file: {e}"
    try:
        translation = await session.translate("traces")
        als_text = translation.get("alloyCode", "// (no Alloy code returned)")
    except RuntimeError as e:
        als_text = f"// Translation failed: {e}"
    return {"dsh": dsh_text, "als": als_text, "file": session.current_file}


@app.post("/api/load")
async def load_model(req: LoadRequest):
    try:
        data = await session.load_file(req.filePath)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/tables")
async def get_tables():
    try:
        return await bridge.send_command("tables")
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/inspect")
async def inspect_model(req: InspectRequest):
    try:
        data = await session.inspect_file(req.filePath)
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
async def init_model(req: InitRequest = None):
    try:
        sig_scopes = req.sigScopes if req else {}
        extra_facts = req.extraFacts if req else []
        data = await session.init(
            sig_scopes=sig_scopes or None,
            extra_facts=extra_facts or None,
        )
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


@app.post("/api/solution/next-init")
async def next_init_solution():
    try:
        data = await bridge.send_command("next-init")
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/step")
async def step(req: StepRequest):
    try:
        state = req.state if req.state is not None else req.initState
        if state is None:
            raise HTTPException(status_code=422, detail="Missing state")
        data = await session.step(
            state,
            sig_scopes=req.sigScopes or None,
            extra_facts=req.extraFacts or None,
        )
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True))


def run():
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
