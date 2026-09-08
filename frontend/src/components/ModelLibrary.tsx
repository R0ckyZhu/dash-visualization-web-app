import { useMemo, useState } from "react";
import type { ExampleModel } from "../api/types";
export function ModelLibrary({
  examples,
  busy,
  onOpen,
}: {
  examples: ExampleModel[];
  busy: boolean;
  onOpen: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const filtered = useMemo(
    () =>
      examples.filter((e) =>
        `${e.name} ${e.group}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [examples, query],
  );
  return (
    <div className="model-library">
      <form
        className="path-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) onOpen(path.trim());
        }}
      >
        <label htmlFor="local-model-path">Open a local model</label>
        <div className="input-action">
          <input
            id="local-model-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\models\example.dsh"
          />
          <button
            className="primary"
            disabled={busy || !path.trim()}
            type="submit"
          >
            Open model
          </button>
        </div>
        <small className="help">
          Enter a .dsh path available to the local server.
        </small>
      </form>
      <div className="library-heading">
        <h2>
          Example library <span>{examples.length}</span>
        </h2>
        <input
          aria-label="Search examples"
          type="search"
          placeholder="Search models or collections…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="model-list">
        {filtered.map((example) => (
          <button
            disabled={busy}
            className="model-card"
            key={example.path}
            onClick={() => onOpen(example.path)}
          >
            <span className="model-icon" aria-hidden="true">
              ◇
            </span>
            <span>
              <strong>{example.name}</strong>
              <small>{example.group}</small>
            </span>
            <span aria-hidden="true">↗</span>
          </button>
        ))}
        {!filtered.length && (
          <p className="help">
            {examples.length
              ? "No matching models. Try a different search."
              : "Examples are unavailable. Check the server status below, or enter a local path."}
          </p>
        )}
      </div>
    </div>
  );
}
