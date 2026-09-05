export type SimulationMode = "raw" | "simplified";

export interface SessionResponseMeta {
  sessionId: string;
  sessionRevision: number;
}

export interface ExampleModel {
  group: string;
  name: string;
  path: string;
}

export interface DashParam {
  stateName: string;
  paramSig: string;
}

export interface DashState {
  id: string;
  kind: "AND" | "OR" | "BASIC" | string;
  parent: string | null;
  children: string[];
  isDefault: boolean;
  params: DashParam[];
  _paramInstance?: string;
  _originalId?: string;
  _isParamRoot?: boolean;
}

export interface DashTransition {
  id: string;
  from?: string | null;
  to?: string | null;
  on?: string | null;
  send?: string | null;
  when?: string | null;
  do?: string | null;
  _paramInstance?: string;
  _originalId?: string;
}

export interface DashEvent {
  id: string;
  kind: "INT" | "ENV" | string;
  params: DashParam[];
}

export interface DashVar {
  id: string;
  kind: "INT" | "ENV" | string;
  multiplicity: string | null;
  type: string | null;
  params: DashParam[];
}

export interface DashBuffer {
  id: string;
  kind: string;
  element: string;
  params: DashParam[];
}

export interface DashModel {
  rootName: string;
  states: DashState[];
  transitions: DashTransition[];
  events: DashEvent[];
  vars: DashVar[];
  buffers: DashBuffer[];
  _paramInstances?: Record<string, string[]>;
}

export interface InspectResponse extends SessionResponseMeta {
  model: DashModel;
  scopeSigs: string[];
  commandCount: number;
}

export interface SolutionResponse extends SessionResponseMeta {
  satisfiable: boolean;
  terminal?: boolean;
  snapshots?: Record<string, unknown>[];
}

export interface SourceResponse extends SessionResponseMeta {
  dsh: string;
  als: string;
  file: string;
}

export interface InitRequest {
  sigScopes?: Record<string, number>;
  constraints?: string[];
  extraFacts?: string[];
  mode?: SimulationMode;
}

export interface StepRequest extends InitRequest {
  state?: Record<string, unknown>;
  initState?: Record<string, unknown>;
  excludeTransitions?: string[];
}

export interface GeneratedResponse extends SessionResponseMeta {
  available: boolean;
  alloyCode?: string;
  initPredicate?: string;
  insertedFragments?: string[];
  wrapperFragments?: string[];
}

export interface UIContextRequest {
  revision: number;
  stateTree: {
    nodes: unknown[];
    edges: unknown[];
  };
  traceNodeIds: Array<number | string>;
  cursorNodeId: number | string | null;
  selection: Record<string, unknown> | null;
  sigScopes: Record<string, number>;
  simulationMode: SimulationMode;
  constraints: string[];
  triedTransitionsByStart: Record<string, string[]>;
  shownSnapshotsByStart: Record<string, string[]>;
}

export interface SessionContext extends SessionResponseMeta {
  revision: number;
  model: DashModel | null;
  sourcePath: string | null;
  dshSource: string | null;
  alloySource: string | null;
  scopeSigs: string[];
  sigScopes: Record<string, number>;
  simulationMode: SimulationMode;
  constraints: string[];
  snapshots: Record<string, Record<string, unknown>>;
  latestSolution: Record<string, unknown> | null;
  stateTree: {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  };
  traceNodeIds: Array<number | string>;
  cursorNodeId: number | string | null;
  selection: Record<string, unknown> | null;
  triedTransitionsByStart: Record<string, string[]>;
  shownSnapshotsByStart: Record<string, string[]>;
  generatedAlloy: Record<string, unknown> | null;
  conversation: Record<string, unknown>[];
  lastOperation: string | null;
}

export interface LLMCapabilities {
  enabled: boolean;
  provider: string;
  model: string | null;
  streaming: boolean;
  readOnly: boolean;
  tools: string[];
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  sessionRevision: number;
  cursorNodeId: number | string | null;
  selection: Record<string, unknown> | null;
}

export type ChatStreamEvent =
  | {
      type: "message.started";
      conversationId: string;
      messageId: string;
      sessionRevision: number;
      model: string;
    }
  | { type: "message.delta"; messageId: string; delta: string }
  | { type: "tool.started"; messageId: string; tool: string }
  | { type: "tool.completed"; messageId: string; tool: string; succeeded: boolean }
  | {
      type: "message.completed";
      conversationId: string;
      messageId: string;
      sessionRevision: number;
      currentSessionRevision: number;
      stale: boolean;
      usage: Record<string, number>;
      references: Record<string, unknown>[];
    }
  | { type: "error"; message: string };
