from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

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
from .session_context import (
    SessionContextStore,
    SessionNotFoundError,
    StaleSessionRevisionError,
)
from .session_registry import ManagedSession, SessionCapacityError, SessionRegistry

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

context_store = SessionContextStore()
session_registry: SessionRegistry | None = None
llm_service: LLMService | None = None
cleanup_task: asyncio.Task | None = None

SESSION_COOKIE = "dashviz_session"
SESSION_TTL_SECONDS = int(os.environ.get("DASH_SESSION_TTL_SECONDS", "3600"))
SESSION_MAX_ACTIVE = int(os.environ.get("DASH_MAX_SESSIONS", "16"))
SESSION_COOKIE_SECURE = os.environ.get("DASH_SECURE_COOKIES", "false").lower() in {
    "1",
    "true",
    "yes",
}


async def _cleanup_sessions() -> None:
    while True:
        await asyncio.sleep(min(60, max(1, SESSION_TTL_SECONDS // 2)))
        if session_registry is not None:
            expired = await session_registry.expire()
            if expired:
                logger.info("Expired %d inactive browser session(s)", expired)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global context_store, session_registry, llm_service, cleanup_task
    context_store = SessionContextStore()
    session_registry = SessionRegistry(
        jar_path=JAR_PATH,
        context_store=context_store,
        ttl_seconds=SESSION_TTL_SECONDS,
        max_sessions=SESSION_MAX_ACTIVE,
    )
    llm_service = LLMService(context_store)
    cleanup_task = asyncio.create_task(_cleanup_sessions())
    try:
        yield
    finally:
        cleanup_task.cancel()
        await asyncio.gather(cleanup_task, return_exceptions=True)
        await llm_service.close()
        await session_registry.close()


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


def _allow_local_model_paths() -> bool:
    return os.environ.get("DASH_ALLOW_LOCAL_MODEL_PATHS", "true").lower() in {
        "1",
        "true",
        "yes",
    }


def _resolve_model_path(file_path: str) -> str:
    candidate = Path(file_path).expanduser().resolve()
    if candidate.suffix.lower() != ".dsh" or not candidate.is_file():
        raise HTTPException(status_code=400, detail="Model must be an existing .dsh file")
    if _allow_local_model_paths():
        return str(candidate)

    configured = os.environ.get("DASH_ALLOWED_MODEL_ROOTS", "")
    roots = [EXAMPLES_DIR.resolve()]
    roots.extend(
        Path(value).expanduser().resolve()
        for value in configured.split(os.pathsep)
        if value.strip()
    )
    if not any(candidate.is_relative_to(root) for root in roots):
        raise HTTPException(
            status_code=403,
            detail="Hosted sessions may only open models from the example library",
        )
    return str(candidate)

# Pretty labels for the collection folders.
_GROUP_LABELS = {
    "2019-dash-website": "2019 · dash-website",
    "2022-bandali-thesis": "2022 · bandali-thesis",
    "2022-tamjid-thesis": "2022 · tamjid-thesis",
    "2023-bandali-day-paper": "2023 · bandali-day-paper",
    "local-models": "Local models",
}


# Bundled examples the current Dash+ toolchain cannot load, kept out of the library:
#   nasa-fgs-mode-logic  parser stops on the legacy syntax
#   railway              primes an env variable (ct'), which Dash+ rejects
#   carousel             translator emits util/ordering under the alias "ord" twice
_HIDDEN_EXAMPLES = {
    "2019-dash-website/nasa-fgs-mode-logic/nasa-fgs-mode-logic.dsh",
    "2022-bandali-thesis/railway/railway.dsh",
    "2022-tamjid-thesis/carousel/carousel.dsh",
}


def _default_scopes(file_path: str, scope_sigs: list[str]) -> dict[str, int]:
    """Per-model starting scopes from an optional `<model>.scopes.json` beside the .dsh.

    Some models are unsatisfiable at scope 1 (the elevator's init needs three
    floors), so a uniform default would make them look broken.
    """
    sidecar = Path(file_path).with_suffix(".scopes.json")
    try:
        configured = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        configured = {}
    return {
        sig: configured[sig] if isinstance(configured.get(sig), int) else 1
        for sig in scope_sigs
    }


def _read_dsh_source(file_path: str) -> str | None:
    try:
        return Path(file_path).read_text(encoding="utf-8")
    except OSError:
        return None


def _with_session_metadata(data: dict, session_id: str) -> dict:
    return context_store.attach_metadata(data, session_id)


async def _active_session(request: Request) -> ManagedSession:
    if session_registry is None:
        raise HTTPException(status_code=503, detail="Session service is starting")
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id:
        raise HTTPException(
            status_code=401,
            detail="Browser session is missing. Reload the page to start a new session.",
        )
    managed = await session_registry.get(session_id)
    if managed is None:
        raise HTTPException(
            status_code=401,
            detail="Browser session expired. Reload the page to start a new session.",
        )
    return managed


def _require_matching_session(session_id: str, managed: ManagedSession) -> None:
    if session_id != managed.id:
        raise HTTPException(status_code=404, detail="Session not found")


def _sse(event: dict) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=True)}\n\n"


@app.get("/api/examples")
async def list_examples():
    """Scan backend/examples for bundled case-study .dsh files, grouped by collection."""
    if not EXAMPLES_DIR.exists():
        return {
            "examples": [],
            "allowLocalModelPaths": _allow_local_model_paths(),
        }

    items = []
    for dsh in sorted(EXAMPLES_DIR.rglob("*.dsh")):
        rel = dsh.relative_to(EXAMPLES_DIR)
        if rel.as_posix() in _HIDDEN_EXAMPLES:
            continue
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
    return {
        "examples": items,
        "allowLocalModelPaths": _allow_local_model_paths(),
    }


@app.get("/api/session")
async def get_session_metadata(request: Request):
    """Create or resume the isolated session represented by the secure cookie."""
    if session_registry is None:
        raise HTTPException(status_code=503, detail="Session service is starting")
    managed = None
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id:
        managed = await session_registry.get(session_id)
    if managed is None:
        try:
            managed = await session_registry.create()
        except SessionCapacityError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
    response = JSONResponse(context_store.metadata(managed.id))
    response.set_cookie(
        SESSION_COOKIE,
        managed.id,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return response


@app.delete("/api/session", status_code=204)
async def delete_session(
    response: Response,
    managed: ManagedSession = Depends(_active_session),
):
    if session_registry is not None:
        await session_registry.delete(managed.id)
    response.delete_cookie(SESSION_COOKIE, path="/")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "activeSessions": session_registry.count if session_registry else 0,
    }


@app.get("/api/sessions/{session_id}/context")
async def get_session_context(
    session_id: str,
    managed: ManagedSession = Depends(_active_session),
):
    """Return the canonical model and simulation context for LLM orchestration."""
    _require_matching_session(session_id, managed)
    try:
        return context_store.get(session_id).as_dict()
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/sessions/{session_id}/ui-context")
async def update_ui_context(
    session_id: str,
    req: UIContextRequest,
    managed: ManagedSession = Depends(_active_session),
):
    """Mirror React-owned tree and selection state into the backend session."""
    _require_matching_session(session_id, managed)
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
async def chat(
    session_id: str,
    req: ChatRequest,
    managed: ManagedSession = Depends(_active_session),
):
    _require_matching_session(session_id, managed)
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
async def get_source(managed: ManagedSession = Depends(_active_session)):
    """Return the loaded model's raw .dsh text and its translated .als (Alloy) code."""
    async with managed.operation_lock:
        session = managed.manager
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
        context_store.record_sources(
            dsh_source=dsh_text,
            alloy_source=als_text,
            session_id=managed.id,
        )
        return _with_session_metadata(
            {"dsh": dsh_text, "als": als_text, "file": session.current_file},
            managed.id,
        )


@app.post("/api/load")
async def load_model(
    req: LoadRequest,
    managed: ManagedSession = Depends(_active_session),
):
    file_path = _resolve_model_path(req.filePath)
    async with managed.operation_lock:
        session = await managed.solver()
        try:
            data = await session.load_file(file_path)
            context_store.replace_model(
                model=data,
                source_path=file_path,
                dsh_source=_read_dsh_source(file_path),
                operation="load",
                session_id=managed.id,
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/generated")
async def get_generated(managed: ManagedSession = Depends(_active_session)):
    """Return the generated simulation Alloy from the last init/step, if there was one."""
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            data = await session.generated()
            context_store.record_generated(data, session_id=managed.id)
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/static")
async def get_static_info(managed: ManagedSession = Depends(_active_session)):
    """Return the static part of the current trace: atoms, constants, orderings, Int range."""
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            data = await session.static_info()
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/tables")
async def get_tables(managed: ManagedSession = Depends(_active_session)):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            return await session.bridge.send_command("tables")
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/inspect")
async def inspect_model(
    req: InspectRequest,
    managed: ManagedSession = Depends(_active_session),
):
    file_path = _resolve_model_path(req.filePath)
    async with managed.operation_lock:
        session = await managed.solver()
        try:
            data = await session.inspect_file(file_path)
            data["defaultScopes"] = _default_scopes(file_path, data.get("scopeSigs", []))
            translation = session.current_translation or {}
            context_store.replace_model(
                model=data["model"],
                source_path=file_path,
                scope_sigs=data.get("scopeSigs", []),
                dsh_source=_read_dsh_source(file_path),
                alloy_source=translation.get("alloyCode"),
                operation="inspect",
                session_id=managed.id,
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/model")
async def get_model(managed: ManagedSession = Depends(_active_session)):
    model = context_store.get(managed.id).model
    if model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return _with_session_metadata(model, managed.id)


@app.post("/api/translate")
async def translate_model(
    req: TranslateRequest,
    managed: ManagedSession = Depends(_active_session),
):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            data = await session.translate(req.option)
            context_store.record_translation(data, session_id=managed.id)
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/execute")
async def execute_command(
    req: ExecuteRequest,
    managed: ManagedSession = Depends(_active_session),
):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            data = await session.execute(req.cmdIdx)
            context_store.record_solution(
                data, operation="execute", session_id=managed.id
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/init")
async def init_model(
    req: InitRequest = None,
    managed: ManagedSession = Depends(_active_session),
):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
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
                session_id=managed.id,
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/next")
async def next_solution(managed: ManagedSession = Depends(_active_session)):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            data = await session.next_solution()
            context_store.record_solution(
                data, operation="alt-snapshot", session_id=managed.id
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/next-init")
async def next_init_solution(
    managed: ManagedSession = Depends(_active_session),
):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
        try:
            data = await session.bridge.send_command("next-init")
            context_store.record_solution(
                data,
                operation="alt-init",
                reset_ui=True,
                session_id=managed.id,
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/step")
async def step(
    req: StepRequest,
    managed: ManagedSession = Depends(_active_session),
):
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
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
                session_id=managed.id,
            )
            return _with_session_metadata(data, managed.id)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/solution/alt-trans")
async def alt_trans(
    req: StepRequest,
    managed: ManagedSession = Depends(_active_session),
):
    """Alt Trans: step from the given state, forced to fire a transition not in excludeTransitions."""
    async with managed.operation_lock:
        session = managed.manager
        if session is None:
            raise HTTPException(status_code=404, detail="No model loaded")
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
                session_id=managed.id,
            )
            return _with_session_metadata(data, managed.id)
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
