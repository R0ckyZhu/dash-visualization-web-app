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

type Phase = "collapsed" | "composing" | "expanded";

/**
 * Floating ask bar, bottom centre of the app. Starts as a translucent pill, opens
 * for typing on click, and grows into a conversation panel once something is sent.
 */
export function AskBar({
  onAsk
}: {
  onAsk: (
    question: string,
    history: ChatMessage[],
    controls: AskControls
  ) => Promise<AskResult>;
}) {
  const [phase, setPhase] = useState<Phase>("collapsed");
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
    if (phase !== "collapsed") inputRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages, waiting]);

  function collapse() {
    // Keep the conversation; just fold the panel away.
    setPhase("collapsed");
  }

  async function send() {
    const question = draft.trim();
    if (!question || waiting) return;

    const asked: ChatMessage = { id: `q${Date.now()}`, role: "user", text: question };
    const answerId = `a${Date.now()}`;
    const nextHistory = [...messages, asked];
    setMessages((current) => [
      ...current,
      asked,
      { id: answerId, role: "assistant", text: "" }
    ]);
    setDraft("");
    setPhase("expanded");
    setWaiting(true);
    setStale(false);
    setActivity("Thinking...");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await onAsk(question, nextHistory, {
        conversationId: conversationIdRef.current,
        onDelta: (delta) => {
          setMessages((current) => current.map((message) =>
            message.id === answerId ? { ...message, text: message.text + delta } : message
          ));
        },
        onToolStatus: setActivity,
        signal: controller.signal
      });
      setStale(result.stale);
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      const failure = stopped
        ? "Stopped."
        : error instanceof Error ? error.message : String(error);
      setMessages((current) => current.map((message) =>
        message.id === answerId
          ? {
              ...message,
              text: message.text ? `${message.text}\n\n${failure}` : failure
            }
          : message
      ));
    } finally {
      setWaiting(false);
      setActivity(null);
      abortRef.current = null;
    }
  }

  function clearConversation() {
    abortRef.current?.abort();
    conversationIdRef.current = `conversation-${crypto.randomUUID()}`;
    setMessages([]);
    setActivity(null);
    setStale(false);
  }

  return (
    <div className={`ask-bar ask-${phase}`}>
      {phase === "expanded" ? (
        <section className="ask-panel" aria-label="Conversation">
          <header>
            <h3>Ask</h3>
            <div>
              <button onClick={clearConversation} type="button">
                Clear
              </button>
              <button
                aria-label="Close conversation"
                className="ask-close"
                onClick={collapse}
                type="button"
              >
                ×
              </button>
            </div>
          </header>
          <div className="ask-transcript" ref={transcriptRef}>
            {messages.map((message) => (
              <article className={`ask-message ask-${message.role}`} key={message.id}>
                {message.text || (waiting ? "Thinking..." : "No response text.")}
              </article>
            ))}
            {activity && activity !== "Thinking..." ? (
              <div className="ask-activity">{activity}</div>
            ) : null}
            {stale ? <div className="ask-stale">Based on an earlier simulation state.</div> : null}
          </div>
        </section>
      ) : null}

      {phase === "collapsed" ? (
        <button
          className="ask-pill"
          onClick={() => setPhase(messages.length > 0 ? "expanded" : "composing")}
          type="button"
        >
          <span className="ask-glyph" aria-hidden="true">✳</span>
          <span className="ask-placeholder">Ask anything</span>
        </button>
      ) : (
        <form
          className="ask-pill ask-pill-active"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <span className="ask-glyph" aria-hidden="true">✳</span>
          <input
            aria-label="Ask anything"
            onBlur={() => {
              if (!draft.trim() && messages.length === 0) setPhase("collapsed");
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") collapse();
            }}
            placeholder="Ask anything"
            ref={inputRef}
            value={draft}
          />
          {waiting ? (
            <button
              aria-label="Stop"
              className="ask-send ask-stop"
              onClick={() => abortRef.current?.abort()}
              type="button"
            >
              ■
            </button>
          ) : (
            <button aria-label="Send" className="ask-send" disabled={!draft.trim()} type="submit">
              ↑
            </button>
          )}
        </form>
      )}
    </div>
  );
}
