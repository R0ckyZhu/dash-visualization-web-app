from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Optional


DEFAULT_SESSION_ID = "default"


class SessionNotFoundError(KeyError):
    pass


class StaleSessionRevisionError(ValueError):
    def __init__(self, expected: int, received: int):
        self.expected = expected
        self.received = received
        super().__init__(
            f"Stale session revision: expected {expected}, received {received}"
        )


def _snapshot_id(snapshot: dict[str, Any]) -> str:
    encoded = json.dumps(
        snapshot,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return f"snapshot-{hashlib.sha256(encoded).hexdigest()[:16]}"


@dataclass
class AppSessionContext:
    id: str
    revision: int = 0
    model: Optional[dict[str, Any]] = None
    source_path: Optional[str] = None
    dsh_source: Optional[str] = None
    alloy_source: Optional[str] = None
    scope_sigs: list[str] = field(default_factory=list)
    sig_scopes: dict[str, int] = field(default_factory=dict)
    simulation_mode: str = "simplified"
    constraints: list[str] = field(default_factory=list)
    snapshots: dict[str, dict[str, Any]] = field(default_factory=dict)
    latest_solution: Optional[dict[str, Any]] = None
    state_tree_nodes: list[dict[str, Any]] = field(default_factory=list)
    state_tree_edges: list[dict[str, Any]] = field(default_factory=list)
    trace_node_ids: list[int | str] = field(default_factory=list)
    cursor_node_id: int | str | None = None
    selection: Optional[dict[str, Any]] = None
    tried_transitions_by_start: dict[str, list[str]] = field(default_factory=dict)
    shown_snapshots_by_start: dict[str, list[str]] = field(default_factory=dict)
    generated_alloy: Optional[dict[str, Any]] = None
    conversation: list[dict[str, Any]] = field(default_factory=list)
    last_operation: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "sessionId": self.id,
            "sessionRevision": self.revision,
            "revision": self.revision,
            "model": deepcopy(self.model),
            "sourcePath": self.source_path,
            "dshSource": self.dsh_source,
            "alloySource": self.alloy_source,
            "scopeSigs": list(self.scope_sigs),
            "sigScopes": dict(self.sig_scopes),
            "simulationMode": self.simulation_mode,
            "constraints": list(self.constraints),
            "snapshots": deepcopy(self.snapshots),
            "latestSolution": deepcopy(self.latest_solution),
            "stateTree": {
                "nodes": deepcopy(self.state_tree_nodes),
                "edges": deepcopy(self.state_tree_edges),
            },
            "traceNodeIds": list(self.trace_node_ids),
            "cursorNodeId": self.cursor_node_id,
            "selection": deepcopy(self.selection),
            "triedTransitionsByStart": deepcopy(self.tried_transitions_by_start),
            "shownSnapshotsByStart": deepcopy(self.shown_snapshots_by_start),
            "generatedAlloy": deepcopy(self.generated_alloy),
            "conversation": deepcopy(self.conversation),
            "lastOperation": self.last_operation,
        }


class SessionContextStore:
    """Canonical model and simulation context for the future LLM layer.

    The Java bridge currently owns one solver process, so the initial registry
    intentionally exposes one default app session. Keeping the ID in the API
    allows multiple isolated solver sessions to be added later without another
    frontend contract change.
    """

    def __init__(self):
        self._sessions = {
            DEFAULT_SESSION_ID: AppSessionContext(id=DEFAULT_SESSION_ID)
        }

    def get(self, session_id: str = DEFAULT_SESSION_ID) -> AppSessionContext:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise SessionNotFoundError(session_id) from exc

    def snapshot(
        self, session_id: str = DEFAULT_SESSION_ID
    ) -> AppSessionContext:
        return deepcopy(self.get(session_id))

    def append_conversation_message(
        self,
        *,
        conversation_id: str,
        role: str,
        text: str,
        session_revision: int,
        session_id: str = DEFAULT_SESSION_ID,
    ) -> None:
        session = self.get(session_id)
        session.conversation.append(
            {
                "conversationId": conversation_id,
                "role": role,
                "text": text,
                "sessionRevision": session_revision,
            }
        )

    def metadata(self, session_id: str = DEFAULT_SESSION_ID) -> dict[str, Any]:
        session = self.get(session_id)
        return {
            "sessionId": session.id,
            "sessionRevision": session.revision,
            "modelLoaded": session.model is not None,
            "lastOperation": session.last_operation,
        }

    def attach_metadata(
        self,
        payload: dict[str, Any],
        session_id: str = DEFAULT_SESSION_ID,
    ) -> dict[str, Any]:
        return {**deepcopy(payload), **self.metadata(session_id)}

    def replace_model(
        self,
        *,
        model: dict[str, Any],
        source_path: str,
        scope_sigs: Optional[list[str]] = None,
        dsh_source: Optional[str] = None,
        alloy_source: Optional[str] = None,
        operation: str,
        session_id: str = DEFAULT_SESSION_ID,
    ) -> AppSessionContext:
        previous = self.get(session_id)
        replacement = AppSessionContext(
            id=session_id,
            revision=previous.revision + 1,
            model=deepcopy(model),
            source_path=source_path,
            dsh_source=dsh_source,
            alloy_source=alloy_source,
            scope_sigs=list(scope_sigs or []),
            last_operation=operation,
        )
        self._sessions[session_id] = replacement
        return replacement

    def record_translation(
        self,
        translation: dict[str, Any],
        *,
        operation: str = "translate",
        session_id: str = DEFAULT_SESSION_ID,
    ) -> AppSessionContext:
        session = self.get(session_id)
        session.revision += 1
        session.alloy_source = translation.get("alloyCode", session.alloy_source)
        scope_sigs = translation.get("scopeSigs")
        if isinstance(scope_sigs, list):
            session.scope_sigs = list(scope_sigs)
        session.last_operation = operation
        return session

    def record_sources(
        self,
        *,
        dsh_source: Optional[str] = None,
        alloy_source: Optional[str] = None,
        session_id: str = DEFAULT_SESSION_ID,
    ) -> AppSessionContext:
        session = self.get(session_id)
        if dsh_source is not None:
            session.dsh_source = dsh_source
        if alloy_source is not None:
            session.alloy_source = alloy_source
        return session

    def record_solution(
        self,
        solution: dict[str, Any],
        *,
        operation: str,
        sig_scopes: Optional[dict[str, int]] = None,
        constraints: Optional[list[str]] = None,
        mode: Optional[str] = None,
        origin_snapshot: Optional[dict[str, Any]] = None,
        reset_ui: bool = False,
        session_id: str = DEFAULT_SESSION_ID,
    ) -> AppSessionContext:
        session = self.get(session_id)
        session.revision += 1
        if sig_scopes is not None:
            session.sig_scopes = dict(sig_scopes)
        if constraints is not None:
            session.constraints = list(constraints)
        if mode is not None:
            session.simulation_mode = mode
        if reset_ui:
            session.state_tree_nodes = []
            session.state_tree_edges = []
            session.trace_node_ids = []
            session.cursor_node_id = None
            session.selection = None
            session.tried_transitions_by_start = {}
            session.shown_snapshots_by_start = {}

        if origin_snapshot is not None:
            session.snapshots[_snapshot_id(origin_snapshot)] = deepcopy(origin_snapshot)
        for snapshot in solution.get("snapshots", []) or []:
            if isinstance(snapshot, dict):
                session.snapshots[_snapshot_id(snapshot)] = deepcopy(snapshot)

        session.latest_solution = deepcopy(solution)
        session.last_operation = operation
        return session

    def record_generated(
        self,
        generated: dict[str, Any],
        session_id: str = DEFAULT_SESSION_ID,
    ) -> AppSessionContext:
        session = self.get(session_id)
        session.generated_alloy = deepcopy(generated)
        return session

    def update_ui_context(
        self,
        *,
        revision: int,
        state_tree: dict[str, Any],
        trace_node_ids: list[int | str],
        cursor_node_id: int | str | None,
        selection: Optional[dict[str, Any]],
        sig_scopes: dict[str, int],
        simulation_mode: str,
        constraints: list[str],
        tried_transitions_by_start: dict[str, list[str]],
        shown_snapshots_by_start: dict[str, list[str]],
        session_id: str = DEFAULT_SESSION_ID,
    ) -> AppSessionContext:
        session = self.get(session_id)
        if revision != session.revision:
            raise StaleSessionRevisionError(session.revision, revision)

        session.state_tree_nodes = deepcopy(state_tree.get("nodes", []))
        session.state_tree_edges = deepcopy(state_tree.get("edges", []))
        session.trace_node_ids = list(trace_node_ids)
        session.cursor_node_id = cursor_node_id
        session.selection = deepcopy(selection)
        session.sig_scopes = dict(sig_scopes)
        session.simulation_mode = simulation_mode
        session.constraints = list(constraints)
        session.tried_transitions_by_start = deepcopy(tried_transitions_by_start)
        session.shown_snapshots_by_start = deepcopy(shown_snapshots_by_start)

        for node in session.state_tree_nodes:
            snapshot = node.get("snapshot", {}).get("raw")
            if isinstance(snapshot, dict):
                session.snapshots[_snapshot_id(snapshot)] = deepcopy(snapshot)
        return session
