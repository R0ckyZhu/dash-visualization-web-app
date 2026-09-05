import { useEffect, useRef } from "react";

interface ScopeDialogProps {
  open: boolean;
  scopes: Record<string, number>;
  scopeSigs: string[];
  onChange: (sig: string, value: number) => void;
  onClose: () => void;
  onRun: () => void;
}

function clampScope(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(20, Math.max(1, Math.round(value)));
}

export function ScopeDialog({ open, scopes, scopeSigs, onChange, onClose, onRun }: ScopeDialogProps) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => firstInputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="scope-dialog-title"
        className="scope-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter") onRun();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="scope-dialog-title">Sig Scopes</h2>
        </header>
        <div className="scope-form">
          {scopeSigs.map((sig, index) => (
            <label className="scope-row" key={sig}>
              <span>{sig}</span>
              <input
                min={1}
                max={20}
                onChange={(event) => onChange(sig, clampScope(Number(event.target.value)))}
                ref={index === 0 ? firstInputRef : undefined}
                type="number"
                value={scopes[sig] ?? 1}
              />
            </label>
          ))}
        </div>
        <footer>
          <button onClick={onClose} type="button">
            Cancel
          </button>
          <button className="run-action" onClick={onRun} type="button">
            Run Simulation
          </button>
        </footer>
      </section>
    </div>
  );
}
