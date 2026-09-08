import { useState } from "react";
import { Modal } from "./Modal";
export function ScopeDialog({
  scopes,
  scopeSigs,
  hasRun,
  onClose,
  onApply,
}: {
  scopes: Record<string, number>;
  scopeSigs: string[];
  hasRun: boolean;
  onClose: () => void;
  onApply: (scopes: Record<string, number>, start: boolean) => void;
}) {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(scopeSigs.map((sig) => [sig, String(scopes[sig] ?? 1)])),
  );
  const valid = scopeSigs.every(
    (sig) =>
      /^\d+$/.test(draft[sig]) &&
      Number(draft[sig]) >= 1 &&
      Number(draft[sig]) <= 20,
  );
  function submit(start: boolean) {
    if (valid)
      onApply(
        Object.fromEntries(scopeSigs.map((sig) => [sig, Number(draft[sig])])),
        start,
      );
  }
  return (
    <Modal title="Model scopes" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(true);
        }}
      >
        <div className="modal-body">
          <p className="help">
            Choose how many instances of each signature to explore.
          </p>
          {scopeSigs.map((sig) => (
            <label className="scope-row" key={sig}>
              <span>{sig}</span>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                required
                value={draft[sig]}
                onChange={(e) =>
                  setDraft((current) => ({ ...current, [sig]: e.target.value }))
                }
              />
            </label>
          ))}
          {!valid && (
            <p role="alert" className="validation-error">
              Enter a whole number from 1 to 20 for each scope.
            </p>
          )}
          {hasRun && (
            <p className="notice">
              Applying changed scopes resets the current trace and state tree.
              Cancel keeps your run.
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!valid} onClick={() => submit(false)}>
            Apply
          </button>
          <button className="primary" type="submit" disabled={!valid}>
            Apply and start
          </button>
        </footer>
      </form>
    </Modal>
  );
}
