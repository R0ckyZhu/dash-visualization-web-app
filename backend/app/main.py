from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .java_bridge import JavaBridge
from .llm import LLMService
from .llm.provider import LLMProviderError
from .llm.schemas import ChatRequest
from .llm.service import (
    ChatRevisionError,
    LLMNotConfiguredError,
    ModelContextRequiredError,
)
from .models import (
    ExecuteRequest,
    InitRequest,
    InspectRequest,
    LoadRequest,
    StepRequest,
    TranslateRequest,
    UIContextRequest,
)
from .session import SessionManager
from .session_context import (
    DEFAULT_SESSION_ID,
    SessionContextStore,
    SessionNotFoundError,
    StaleSessionRevisionError,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dash-viz")

JAR_PATH = os.environ.get(
    "DASHPLUS_JAR",
    str(
        Path(__file__).resolve().parent.parent.parent
        / "sessionserver"
        / "build"
        / "libs"
        / "dashplus-session-server.jar"
    ),
)

bridge: Optional[JavaBridge] = None
session: Optional[SessionManager] = None
context_store = SessionContextStore()
llm_service: Optional[LLMService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global bridge, session, context_store, llm_service
    bridge = JavaBridge(JAR_PATH)
    await bridge.start()
    session = SessionManager(bridge)
    context_store = SessionContextStore()
    llm_service = LLMService(context_store)
    yield
    await llm_service.close()
    await bridge.stop()


app = FastAPI(title="Dash Visualizer", lifespan=lifespan)

_DEFAULT_CORS_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173"
cors_origins = [
    origin.strip()
    for origin in os.environ.get("DASH_CORS_ORIGINS", _DEFAULT_CORS_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
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


def _read_dsh_source(file_path: str) -> Optional[str]:
    try:
        return Path(file_path).read_text(encoding="utf-8")
    except OSError:
        return None


def _with_session_metadata(data: dict) -> dict:
    return context_store.attach_metadata(data)


def _sse(event: dict) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=True)}\n\n"


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


@app.get("/api/session")
async def get_session_metadata():
    """Return the active logical session used by the single solver process."""
    return context_store.metadata()


@app.get("/api/sessions/{session_id}/context")
async def get_session_context(session_id: str):
    """Return the canonical model and simulation context for LLM orchestration."""
    try:
        return context_store.get(session_id).as_dict()
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/sessions/{session_id}/ui-context")
async def update_ui_context(session_id: str, req: UIContextRequest):
    """Mirror React-owned tree and selection state into the backend session."""
    try:
        context_store.update_ui_context(
            session_id=session_id,
            revision=req.revision,
            state_tree=req.stateTree.model_dump(),
            trace_node_ids=req.traceNodeIds,
            cursor_node_id=req.cursorNodeId,
            selection=req.selection,
            sig_scopes=req.sigScopes,
            simulation_mode=req.simulationMode,
            constraints=req.constraints,
            tried_transitions_by_start=req.triedTransitionsByStart,
            shown_snapshots_by_start=req.shownSnapshotsByStart,
        )
        return context_store.metadata(session_id)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except StaleSessionRevisionError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": str(exc),
                "expectedRevision": exc.expected,
                "receivedRevision": exc.received,
            },
        )


@app.get("/api/llm/capabilities")
async def get_llm_capabilities():
    if llm_service is None:
        return {"enabled": False, "streaming": True, "readOnly": True, "tools": []}
    return llm_service.capabilities()


@app.post("/api/sessions/{session_id}/chat")
async def chat(session_id: str, req: ChatRequest):
    if llm_service is None:
        raise HTTPException(status_code=503, detail="The assistant is not available")
    try:
        context = llm_service.prepare(session_id, req)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ModelContextRequiredError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ChatRevisionError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": str(exc),
                "expectedRevision": exc.expected,
                "receivedRevision": exc.received,
            },
        )

    async def event_stream():
        try:
            async for event in llm_service.stream_chat(context, req):
                yield _sse(event)
        except asyncio.CancelledError:
            raise
        except LLMProviderError as exc:
            logger.warning("LLM provider error: %s", exc)
            yield _sse({"type": "error", "message": str(exc)})
        except Exception:
            logger.exception("Unexpected LLM chat failure")
            yield _sse(
                {
                    "type": "error",
                    "message": "The assistant failed unexpectedly. Check the backend log.",
                }
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


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
    context_store.record_sources(dsh_source=dsh_text, alloy_source=als_text)
    return _with_session_metadata(
        {"dsh": dsh_text, "als": als_text, "file": session.current_file}
    )


@app.post("/api/load")
async def load_model(req: LoadRequest):
    try:
        data = await session.load_file(req.filePath)
        context_store.replace_model(
            model=data,
            source_path=req.filePath,
            dsh_source=_read_dsh_source(req.filePath),
            operation="load",
        )
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/generated")
async def get_generated():
    """Return the generated simulation Alloy from the last init/step, if there was one."""
    if session is None:
        raise HTTPException(status_code=404, detail="No session")
    try:
        data = await session.generated()
        context_store.record_generated(data)
        return _with_session_metadata(data)
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
        translation = session.current_translation or {}
        context_store.replace_model(
            model=data["model"],
            source_path=req.filePath,
            scope_sigs=data.get("scopeSigs", []),
            dsh_source=_read_dsh_source(req.filePath),
            alloy_source=translation.get("alloyCode"),
            operation="inspect",
        )
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/model")
async def get_model():
    model = session.get_model()
    if model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return _with_session_metadata(model)


@app.post("/api/translate")
async def translate_model(req: TranslateRequest):
    try:
        data = await session.translate(req.option)
        context_store.record_translation(data)
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/execute")
async def execute_command(req: ExecuteRequest):
    try:
        data = await session.execute(req.cmdIdx)
        context_store.record_solution(data, operation="execute")
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/init")
async def init_model(req: InitRequest = None):
    try:
        sig_scopes = req.sigScopes if req else {}
        constraints = req.constraints if req else []
        extra_facts = req.extraFacts if req else []
        mode = req.mode if req else None
        data = await session.init(
            sig_scopes=sig_scopes or None,
            constraints=constraints or None,
            extra_facts=extra_facts or None,
            mode=mode,
        )
        context_store.record_solution(
            data,
            operation="init",
            sig_scopes=sig_scopes,
            constraints=constraints,
            mode=mode,
            reset_ui=True,
        )
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/next")
async def next_solution():
    try:
        data = await session.next_solution()
        context_store.record_solution(data, operation="alt-snapshot")
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/next-init")
async def next_init_solution():
    try:
        data = await bridge.send_command("next-init")
        context_store.record_solution(
            data,
            operation="alt-init",
            reset_ui=True,
        )
        return _with_session_metadata(data)
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
            constraints=req.constraints or None,
            extra_facts=req.extraFacts or None,
            mode=req.mode,
        )
        context_store.record_solution(
            data,
            operation="step",
            sig_scopes=req.sigScopes,
            constraints=req.constraints,
            mode=req.mode,
            origin_snapshot=state,
        )
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/alt-trans")
async def alt_trans(req: StepRequest):
    """Alt Trans: step from the given state, forced to fire a transition not in excludeTransitions."""
    try:
        state = req.state if req.state is not None else req.initState
        if state is None:
            raise HTTPException(status_code=422, detail="Missing state")
        data = await session.step(
            state,
            sig_scopes=req.sigScopes or None,
            constraints=req.constraints or None,
            extra_facts=req.extraFacts or None,
            mode=req.mode,
            exclude_transitions=req.excludeTransitions or None,
            command="alt-trans",
        )
        context_store.record_solution(
            data,
            operation="alt-trans",
            sig_scopes=req.sigScopes,
            constraints=req.constraints,
            mode=req.mode,
            origin_snapshot=state,
        )
        return _with_session_metadata(data)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend" / "dist"

_MISSING_FRONTEND = (
    f"Compiled frontend not found at {FRONTEND_DIR}.\n"
    "The bundle is tracked in Git, so a normal checkout has it. If you removed "
    "it, rebuild with:\n"
    "    cd frontend && pnpm install --frozen-lockfile && pnpm run build\n"
    "The API remains available under /api."
)

# There is no fallback. Serving a stale interface silently is worse than saying
# plainly that the bundle is missing.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True))
else:
    logger.error(_MISSING_FRONTEND)

    @app.get("/", response_class=PlainTextResponse, status_code=503)
    async def frontend_missing():
        return _MISSING_FRONTEND


def run():
    import uvicorn

    host = os.environ.get("DASH_HOST", "127.0.0.1")
    port = int(os.environ.get("DASH_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)


# Allows `python -m app.main`, which works even when the interpreter's scripts
# directory is not on PATH — common when installing into an ambient Python.
if __name__ == "__main__":
    run()
