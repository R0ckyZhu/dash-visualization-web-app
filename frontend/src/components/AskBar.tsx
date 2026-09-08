import { useEffect, useRef, useState } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface AskControls {
  conversationId: string;
  onDelta: (delta: string) => void;
  onToolStatus: (status: string | null) => void;
  signal: AbortSignal;
}

export interface AskResult {
  stale: boolean;
}

/**
 * Docked assistant. Keep mounted across panel switches to retain the conversation.
 */
export function AskBar({
  onAsk,
  enabled,
  context,
}: {
  enabled: boolean;
  context: string;
  onAsk: (
    question: string,
    history: ChatMessage[],
    controls: AskControls,
  ) => Promise<AskResult>;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef(`conversation-${crypto.randomUUID()}`);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages, waiting]);

  async function send() {
    const question = draft.trim();
    if (!enabled || !question || waiting) return;

    const asked: ChatMessage = {
      id: `q${Date.now()}`,
      role: "user",
      text: question,
    };
    const answerId = `a${Date.now()}`;
    const nextHistory = [...messages, asked];
    setMessages((current) => [
      ...current,
      asked,
      { id: answerId, role: "assistant", text: "" },
    ]);
    setDraft("");
    setWaiting(true);
    setStale(false);
    setActivity("Thinking...");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await onAsk(question, nextHistory, {
        conversationId: conversationIdRef.current,
        onDelta: (delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === answerId
                ? { ...message, text: message.text + delta }
                : message,
            ),
          );
        },
        onToolStatus: setActivity,
        signal: controller.signal,
      });
      setStale(result.stale);
    } catch (error) {
      const stopped =
        error instanceof DOMException && error.name === "AbortError";
      const failure = stopped
        ? "Stopped."
        : error instanceof Error
          ? error.message
          : String(error);
      setMessages((current) =>
        current.map((message) =>
          message.id === answerId
            ? {
                ...message,
                text: message.text ? `${message.text}\n\n${failure}` : failure,
              }
            : message,
        ),
      );
    } finally {
      setWaiting(false);
      setActivity(null);
      abortRef.current = null;
    }
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  function clearConversation() {
    abortRef.current?.abort();
    conversationIdRef.current = `conversation-${crypto.randomUUID()}`;
    setMessages([]);
    setActivity(null);
    setStale(false);
  }

  return (
    <div className="ask-bar ask-expanded">
      <p className="assistant-context">{context}</p>
      {!enabled && (
        <p className="notice">
          Assistant unavailable. Configure the local assistant service to ask
          about this model.
        </p>
      )}
      {messages.length === 0 && enabled && (
        <div className="assistant-welcome">
          <span aria-hidden="true">✳</span>
          <h2>Understand this model</h2>
          <p>
            Ask about a state, a transition, or what changed in this snapshot.
          </p>
          <button
            onClick={() => {
              setDraft("Explain the selected state or transition.");
              inputRef.current?.focus();
            }}
          >
            Explain my selection
          </button>
          <button
            onClick={() => {
              setDraft("Summarize the current snapshot.");
              inputRef.current?.focus();
            }}
          >
            Summarize this snapshot
          </button>
        </div>
      )}
      <section className="ask-panel" aria-label="Conversation">
        <header>
          <h3>Conversation</h3>
          <button
            disabled={waiting || !messages.length}
            onClick={clearConversation}
          >
            Clear
          </button>
        </header>
        <div className="ask-transcript" ref={transcriptRef}>
          {messages.map((message) => (
            <article
              className={`ask-message ask-${message.role}`}
              key={message.id}
            >
              {message.text || (waiting ? "Thinking…" : "No response text.")}
            </article>
          ))}
          {activity && (
            <div className="ask-activity" role="status">
              {activity}
            </div>
          )}
          {stale && (
            <div className="ask-stale">
              Based on an earlier simulation state.
            </div>
          )}
        </div>
      </section>
      <form
        className="ask-pill ask-pill-active"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          aria-label="Ask about this model"
          disabled={!enabled}
          placeholder="Ask about this model…"
          value={draft}
          ref={inputRef}
          onChange={(e) => setDraft(e.target.value)}
        />
        {waiting ? (
          <button
            type="button"
            aria-label="Stop"
            className="ask-send ask-stop"
            onClick={() => abortRef.current?.abort()}
          >
            ■
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            className="ask-send"
            disabled={!enabled || !draft.trim()}
          >
            ↑
          </button>
        )}
      </form>
    </div>
  );
}
