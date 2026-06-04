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
    parent: str | None
    children: list[str]
    isDefault: bool
    params: list[DashParam]


class DashTransition(BaseModel):
    model_config = {"populate_by_name": True}

    id: str
    from_: str | None = Field(None, alias="from")
    to: str | None = None
    on: str | None = None
    send: str | None = None
    when: str | None = None
    do: str | None = None


class DashEvent(BaseModel):
    id: str
    kind: str  # INT | ENV
    params: list[DashParam]


class DashVar(BaseModel):
    id: str
    kind: str  # INT | ENV
    multiplicity: str | None
    type: str | None
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
    sigScopes: dict[str, int] = {}
    # Optional Alloy predicate bodies that will be ANDed into the run command.
    # Each entry is a raw expression evaluated against the snapshot trace,
    # e.g. "Counter_Tk0 in __Snapshot/first.__events0" to force Tk0 to be queued
    # at init, or "not __stutter[s0, s0.next]" style assertions on step.
    extraFacts: list[str] = []


class StepRequest(BaseModel):
    state: dict | None = None
    initState: dict | None = None
    sigScopes: dict[str, int] = {}
    extraFacts: list[str] = []
