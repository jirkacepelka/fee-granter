"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./Dropdown.module.css";

interface DropdownProps {
  /** Rendered as the button; receives whether the panel is open. */
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  label: string;
  panelClassName?: string;
  /** Notified when the panel opens or closes, for lazy-loading its content. */
  onOpenChange?: (open: boolean) => void;
}

/** A popover that closes on outside click, Escape, or from its own content. */
export function Dropdown({
  trigger,
  children,
  align = "left",
  label,
  panelClassName,
  onOpenChange,
}: DropdownProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    onOpenChange?.(open);
    // Only the open state should retrigger this; the callback identity is the
    // caller's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
      >
        {trigger(open)}
      </button>
      {open ? (
        <div
          className={`${styles.panel} ${align === "right" ? styles.right : styles.left} ${
            panelClassName ?? ""
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
