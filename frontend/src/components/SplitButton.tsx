import { useEffect, useRef, useState, type ReactNode } from "react";

interface SplitButtonProps {
  menuOnly?: boolean;
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
  menuOnly = false,
  align = "right",
  children,
  className,
  label,
  menuDisabled,
  menuLabel,
  onAction,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    rootRef.current
      ?.querySelector<HTMLElement>(
        '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
      )
      ?.focus();
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className={`split-button${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <button
        ref={menuOnly ? triggerRef : undefined}
        className={menuOnly ? "menu-trigger" : "split-main"}
        disabled={actionDisabled}
        aria-haspopup={menuOnly ? "menu" : undefined}
        aria-expanded={menuOnly ? open : undefined}
        onClick={menuOnly ? () => setOpen((current) => !current) : onAction}
        type="button"
      >
        {label}
        {menuOnly ? " ▾" : ""}
      </button>
      {!menuOnly && (
        <button
          ref={triggerRef}
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
      )}
      {open ? (
        <div
          className={`split-menu split-menu-${align}`}
          role="menu"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }
            if (event.key === "Tab") setOpen(false);
          }}
        >
          {children(() => {
            setOpen(false);
            triggerRef.current?.focus();
          })}
        </div>
      ) : null}
    </div>
  );
}
