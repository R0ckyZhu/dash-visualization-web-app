from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class LoadRequest(BaseModel):
    filePath: str


class InspectRequest(BaseModel):
    filePath: str


class DashParam(BaseModel):
    stateName: str
    paramSig: str


class DashState(BaseModel):
    id: str
    kind: str  # AND | OR | BASIC
    parent: Optional[str]
    children: list[str]
    isDefault: bool
    params: list[DashParam]


class DashTransition(BaseModel):
    model_config = {"populate_by_name": True}

    id: str
    from_: Optional[str] = Field(None, alias="from")
    to: Optional[str] = None
    on: Optional[str] = None
    send: Optional[str] = None
    when: Optional[str] = None
    do: Optional[str] = None


class DashEvent(BaseModel):
    id: str
    kind: str  # INT | ENV
    params: list[DashParam]


class DashVar(BaseModel):
    id: str
    kind: str  # INT | ENV
    multiplicity: Optional[str]
    type: Optional[str]
    params: list[DashParam]


class DashBuffer(BaseModel):
    id: str
    kind: str
    element: str
    params: list[DashParam]


class DashModelResponse(BaseModel):
    rootName: str
    states: list[DashState]
    transitions: list[DashTransition]
    events: list[DashEvent]
    vars: list[DashVar]
    buffers: list[DashBuffer]


class TranslateRequest(BaseModel):
    option: str = "traces"


class ExecuteRequest(BaseModel):
    cmdIdx: int = -1


class InitRequest(BaseModel):
    sigScopes: dict[str, int] = Field(default_factory=dict)
    # Constraint predicates from the constraint panel (Alloy expressions).
    # For init: env event constraints like "SnapshotUI_login in __webapp_events[s]".
    constraints: list[str] = Field(default_factory=list)
    extraFacts: list[str] = Field(default_factory=list)
    # Simulation mode: "simplified" (adds the trans_enabled predicate, so dead-end
    # snapshots are detected and drawn as trace ends) or "raw" (no such predicate,
    # so any successor the constraints permit is returned).
    mode: str = "simplified"


class StepRequest(BaseModel):
    state: Optional[dict] = None
    initState: Optional[dict] = None
    sigScopes: dict[str, int] = Field(default_factory=dict)
    # Constraint predicates from the constraint panel (Alloy expressions).
    # For step: event/transition/state/variable/custom constraints on the successor.
    constraints: list[str] = Field(default_factory=list)
    extraFacts: list[str] = Field(default_factory=list)
    # Simulation mode: "simplified" or "raw" (see InitRequest).
    mode: str = "simplified"
    # Alt Trans: transition atoms already taken from this start node. The step is forced to fire a
    # transition NOT in this list. Empty for a normal step.
    excludeTransitions: list[str] = Field(default_factory=list)


class StateTreeContext(BaseModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class UIContextRequest(BaseModel):
    revision: int
    stateTree: StateTreeContext = Field(default_factory=StateTreeContext)
    traceNodeIds: list[int | str] = Field(default_factory=list)
    cursorNodeId: int | str | None = None
    selection: Optional[dict[str, Any]] = None
    sigScopes: dict[str, int] = Field(default_factory=dict)
    simulationMode: str = "simplified"
    constraints: list[str] = Field(default_factory=list)
    triedTransitionsByStart: dict[str, list[str]] = Field(default_factory=dict)
    shownSnapshotsByStart: dict[str, list[str]] = Field(default_factory=dict)
