import type {
  DashModel,
  ExampleModel,
  ChatRequest,
  ChatStreamEvent,
  InitRequest,
  InspectResponse,
  GeneratedResponse,
  LLMCapabilities,
  SessionContext,
  SessionResponseMeta,
  SolutionResponse,
  SourceResponse,
  StaticInfoResponse,
  StepRequest,
  UIContextRequest,
} from "./types";

const API_ROOT = import.meta.env.VITE_API_ROOT ?? "";
type SessionMetadata = SessionResponseMeta & {
  modelLoaded: boolean;
  lastOperation: string | null;
};
let sessionPromise: Promise<SessionMetadata> | null = null;

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  const detail = body.detail;
  const message =
    typeof detail === "string"
      ? detail
      : typeof detail?.message === "string"
        ? detail.message
        : `${response.status} ${response.statusText}`;
  return new Error(message);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return response.json() as Promise<T>;
}

function ensureSession(): Promise<SessionMetadata> {
  if (!sessionPromise) {
    sessionPromise = request<SessionMetadata>("/api/session").catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

async function sessionRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  await ensureSession();
  return request<T>(path, options);
}

export const dashApi = {
  session: ensureSession,

  sessionContext: (sessionId: string) =>
    sessionRequest<SessionContext>(
      `/api/sessions/${encodeURIComponent(sessionId)}/context`,
    ),

  updateUiContext: (
    sessionId: string,
    body: UIContextRequest,
    signal?: AbortSignal,
  ) =>
    sessionRequest<SessionResponseMeta>(
      `/api/sessions/${encodeURIComponent(sessionId)}/ui-context`,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      },
    ),

  llmCapabilities: () => request<LLMCapabilities>("/api/llm/capabilities"),

  streamChat: async (
    sessionId: string,
    body: ChatRequest,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ) => {
    await ensureSession();
    const response = await fetch(
      `${API_ROOT}/api/sessions/${encodeURIComponent(sessionId)}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) throw await responseError(response);
    if (!response.body)
      throw new Error("The assistant returned no response stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const result: {
      completed: Extract<ChatStreamEvent, { type: "message.completed" }> | null;
    } = { completed: null };

    function consume(block: string) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      const event = JSON.parse(data) as ChatStreamEvent;
      onEvent(event);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "message.completed") result.completed = event;
    }

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!result.completed)
      throw new Error("The assistant stream ended before completion.");
    return result.completed;
  },

  examples: async () => {
    return request<{
      examples: ExampleModel[];
      allowLocalModelPaths: boolean;
    }>("/api/examples");
  },

  inspect: (filePath: string) =>
    sessionRequest<InspectResponse>("/api/inspect", {
      method: "POST",
      body: JSON.stringify({ filePath }),
    }),

  load: (filePath: string) =>
    sessionRequest<DashModel & SessionResponseMeta>("/api/load", {
      method: "POST",
      body: JSON.stringify({ filePath }),
    }),

  init: (body: InitRequest) =>
    sessionRequest<SolutionResponse>("/api/init", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  step: (body: StepRequest) =>
    sessionRequest<SolutionResponse>("/api/step", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  altTrans: (body: StepRequest) =>
    sessionRequest<SolutionResponse>("/api/solution/alt-trans", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  nextSolution: () =>
    sessionRequest<SolutionResponse>("/api/solution/next", { method: "POST" }),

  nextInitSolution: () =>
    sessionRequest<SolutionResponse>("/api/solution/next-init", {
      method: "POST",
    }),

  source: () => sessionRequest<SourceResponse>("/api/source"),

  generated: () => sessionRequest<GeneratedResponse>("/api/generated"),
  staticInfo: () => sessionRequest<StaticInfoResponse>("/api/static"),
};
