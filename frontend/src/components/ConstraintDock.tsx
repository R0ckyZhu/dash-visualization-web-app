import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AppliedConstraint } from "../state/constraints";

interface DockPosition {
  x: number;
  y: number;
}

/**
 * Floating, draggable list of everything in force for the next solve: the user's
 * own predicates, then every paragraph the app adds to the translated model.
 */
export function ConstraintDock({
  constraints,
  enabled,
  onClose
}: {
  constraints: AppliedConstraint[];
  enabled: boolean;
  onClose: () => void;
}) {
  const dockRef = useRef<HTMLElement | null>(null);
  const grabRef = useRef<DockPosition | null>(null);
  const [position, setPosition] = useState<DockPosition | null>(null);

  const mine = constraints.filter((constraint) => constraint.origin === "user");
  const generated = constraints.filter((constraint) => constraint.origin === "app");

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    // Let the close button work; only the bar itself drags.
    if ((event.target as HTMLElement).closest("button")) return;
    const dock = dockRef.current;
    if (!dock) return;

    const bounds = dock.getBoundingClientRect();
    grabRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    setPosition({ x: bounds.left, y: bounds.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const grab = grabRef.current;
    const dock = dockRef.current;
    if (!grab || !dock) return;

    // Keep it on screen: the whole width, and enough height to grab it again.
    const maxX = Math.max(0, window.innerWidth - dock.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - 40);
    setPosition({
      x: Math.min(Math.max(0, event.clientX - grab.x), maxX),
      y: Math.min(Math.max(0, event.clientY - grab.y), maxY)
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!grabRef.current) return;
    grabRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <aside
      aria-label="Constraints in force"
      className="constraint-dock"
      ref={dockRef}
      style={position ? { left: position.x, right: "auto", top: position.y } : undefined}
    >
      <header
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
      >
        <h3>Constraints in force</h3>
        <button aria-label="Close constraint list" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="constraint-dock-body">
        <ConstraintGroup
          badge={mine.length > 0 && !enabled ? "off" : undefined}
          empty="Nothing saved. Add predicates below the Alloy source."
          items={mine}
          muted={!enabled}
          title="Yours"
        />
        <ConstraintGroup
          empty="Nothing generated yet. Run Simulate or Step."
          items={generated}
          title="Added by the app"
        />
      </div>
    </aside>
  );
}

function ConstraintGroup({
  badge,
  empty,
  items,
  muted,
  title
}: {
  badge?: string;
  empty: string;
  items: AppliedConstraint[];
  muted?: boolean;
  title: string;
}) {
  return (
    <section className={`constraint-dock-group${muted ? " muted" : ""}`}>
      <h4>
        {title}
        <small>{items.length}</small>
        {badge ? <em>{badge}</em> : null}
      </h4>
      {items.length === 0 ? (
        <p className="constraint-dock-empty">{empty}</p>
      ) : (
        <ul>
          {items.map((constraint, index) => (
            <li key={`${constraint.text}-${index}`}>
              <code>{constraint.text}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
