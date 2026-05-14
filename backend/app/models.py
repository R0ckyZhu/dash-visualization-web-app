from pydantic import BaseModel, Field


class LoadRequest(BaseModel):
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


class StepRequest(BaseModel):
    initState: dict
    maxScope: int = 10
