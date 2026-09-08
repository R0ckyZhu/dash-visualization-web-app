import { useState } from "react";
import type { AppliedConstraint } from "../state/constraints";
export function ConfigurationPanel({
  draft,
  onDraft,
  onSave,
  saved,
  enabled,
  onToggle,
  generated,
  scopes,
  onScopes,
  busy,
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  saved: string[];
  enabled: boolean;
  onToggle: () => void;
  generated: AppliedConstraint[];
  scopes: Record<string, number>;
  onScopes: () => void;
  busy: boolean;
}) {
  const [generatedOpen, setGeneratedOpen] = useState(false);
  return (
    <div className="configuration-panel">
      <section>
        <div className="panel-section-heading">
          <h2>Model scopes</h2>
          <button
            disabled={!Object.keys(scopes).length || busy}
            onClick={onScopes}
          >
            Edit scopes
          </button>
        </div>
        <p className="help">
          {Object.entries(scopes)
            .map(([sig, count]) => `${sig}: ${count}`)
            .join(" · ") || "This model has no configurable scopes."}
        </p>
      </section>
      <section>
        <div className="panel-section-heading">
          <h2>
            Constraints <span>{saved.length}</span>
          </h2>
          <button
            role="switch"
            aria-checked={enabled}
            aria-label="Constraints enabled"
            disabled={!saved.length || busy}
            onClick={onToggle}
          >
            {enabled ? "On" : "Off"}
          </button>
        </div>
        <p className="help">
          Saved constraints apply to the next solve. Existing snapshots are not
          recomputed.
        </p>
        <label htmlFor="constraint-draft">Alloy predicates</label>
        <textarea
          id="constraint-draft"
          rows={7}
          spellCheck={false}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder="One Alloy predicate per line"
          disabled={busy}
        />
        <div className="constraint-editor-actions">
          <button disabled={busy} onClick={() => onDraft(saved.join("\n"))}>
            Restore saved
          </button>
          <button className="primary" disabled={busy} onClick={onSave}>
            Save constraints
          </button>
        </div>
        <details>
          <summary>Saved predicates ({saved.length})</summary>
          {saved.length ? (
            <pre>{saved.join("\n")}</pre>
          ) : (
            <p className="help">No saved predicates.</p>
          )}
        </details>
      </section>
      <details onToggle={(e) => setGeneratedOpen(e.currentTarget.open)}>
        <summary>Generated Alloy from last solve</summary>
        {generatedOpen &&
          (generated.length ? (
            generated.map((c, i) => <pre key={i}>{c.text}</pre>)
          ) : (
            <p className="help">
              Start or step a simulation to inspect generated Alloy.
            </p>
          ))}
      </details>
    </div>
  );
}
