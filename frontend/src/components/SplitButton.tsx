import { useEffect, useRef, useState, type ReactNode } from "react";

interface SplitButtonProps {
  actionDisabled?: boolean;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
  className?: string;
  label: string;
  menuDisabled?: boolean;
  menuLabel: string;
  onAction: () => void;
}

/**
 * A primary action with a caret that opens a menu of related choices — the
 * toolbar's Open (path + examples) and Simulate (mode) controls.
 */
export function SplitButton({
  actionDisabled,
  align = "right",
  children,
  className,
  label,
  menuDisabled,
  menuLabel,
  onAction
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`split-button${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button className="split-main" disabled={actionDisabled} onClick={onAction} type="button">
        {label}
      </button>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={menuLabel}
        className="split-caret"
        disabled={menuDisabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={`split-menu split-menu-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
