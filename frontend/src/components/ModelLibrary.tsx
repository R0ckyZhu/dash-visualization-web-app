import { useMemo, useState } from "react";
import type { ExampleModel } from "../api/types";
export function ModelLibrary({
  examples,
  allowLocalModelPaths,
  busy,
  onOpen,
}: {
  examples: ExampleModel[];
  allowLocalModelPaths: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const filtered = useMemo(
    () =>
      examples.filter((e) =>
        `${e.name} ${e.group} ${(e.params ?? []).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [examples, query],
  );
  const librarySections = [
    {
      title: "Non-parameterized models",
      description: "Each state and region exists exactly once.",
      models: filtered.filter((e) => !e.params?.length),
    },
    {
      title: "Parameterized models",
      description:
        "Some regions are replicated once per atom of a signature, so you choose how many copies (the scope) before simulating.",
      models: filtered.filter((e) => e.params?.length),
    },
  ];
  return (
    <div className="model-library">
      {allowLocalModelPaths && (
        <form
          className="path-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) onOpen(path.trim());
          }}
        >
          <label htmlFor="local-model-path">Open a local Dash+ model</label>
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
            Enter a Dash+ (.dsh) path available to the local server.
          </small>
        </form>
      )}
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
      {librarySections.map(({ title, description, models }) =>
        models.length === 0 ? null : (
          <section
            className="library-section"
            key={title}
            aria-label={title}
          >
            <header>
              <h3>
                {title} <span>{models.length}</span>
              </h3>
              <p className="help">{description}</p>
            </header>
            <div className="model-list">
              {models.map((example) => (
                <ModelCard
                  busy={busy}
                  example={example}
                  key={example.path}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </section>
        ),
      )}
      {!filtered.length && (
        <p className="help">
          {examples.length
            ? "No matching models. Try a different search."
            : "Examples are unavailable. Check the server status below, or enter a local path."}
        </p>
      )}
    </div>
  );
}

function ModelCard({
  busy,
  example,
  onOpen,
}: {
  busy: boolean;
  example: ExampleModel;
  onOpen: (path: string) => void;
}) {
  const params = example.params ?? [];
  return (
    <button
      disabled={busy}
      className="model-card"
      onClick={() => onOpen(example.path)}
    >
      <span className="model-icon" aria-hidden="true">
        ◇
      </span>
      <span>
        <strong>{example.name}</strong>
        <small>
          {example.group}
          {params.length > 0 && (
            <span className="model-params">
              {" "}
              · per {params.join(", ")}
            </span>
          )}
        </small>
      </span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}
