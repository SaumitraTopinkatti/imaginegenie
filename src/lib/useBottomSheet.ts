import { useEffect, useRef, type TouchEventHandler } from "react";
import { hasOpenDialog } from "../components/Dialog";
import { useHistoryLayer } from "./useHistoryLayer";

/** Mobile sheet breakpoint, shared with Studio's drawer rules. */
export const SHEET_MQ = "(max-width: 900px)";

export interface BottomSheetOpts {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Element holding the sheet's focusables (trap scope). */
  sheetRef: { current: HTMLElement | null };
  peekRef: { current: HTMLElement | null };
  /** Focused on open; defaults to the first textarea. */
  initialFocusSelector?: string;
}

/**
 * Bottom-sheet behaviour mirroring Studio's mobile drawer (App.tsx):
 * desktop auto-close, scroll lock, initial focus, light Tab trap, Esc,
 * swipe-down-to-close on the grab, and guarded focus return to the peek bar.
 * Studio still runs its inline copy; it can adopt this later.
 */
export function useBottomSheet({
  open,
  setOpen,
  sheetRef,
  peekRef,
  initialFocusSelector = "textarea",
}: BottomSheetOpts): {
  grabProps: { onTouchStart: TouchEventHandler; onTouchEnd: TouchEventHandler };
} {
  // Stable close through a ref so effects don't re-run on every render.
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const touchY = useRef<number | null>(null);
  // Back closes the sheet on mobile (desktop auto-close below nets out).
  useHistoryLayer(open, () => setOpenRef.current(false));

  // Desktop kills the sheet (same rule as Studio's drawer).
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpenRef.current(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!window.matchMedia(SHEET_MQ).matches) {
      setOpenRef.current(false);
      return;
    }
    const sheet = sheetRef.current;
    document.body.style.overflow = "hidden";
    sheet?.querySelector<HTMLElement>(initialFocusSelector)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A dialog owns Escape while open (Dialog closes the topmost layer).
        if (hasOpenDialog()) return;
        setOpenRef.current(false);
        return;
      }
      if (e.key !== "Tab" || !sheet) return;
      const items = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
        )
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      // Focus the peek bar only when the sheet owned focus (or it fell to
      // body, as after a backdrop click) — never steal it on tab switches.
      const active = document.activeElement as HTMLElement | null;
      if (
        (sheet && active && sheet.contains(active)) ||
        active === document.body ||
        active == null
      ) {
        peekRef.current?.focus({ preventScroll: true });
      }
    };
  }, [open, sheetRef, peekRef, initialFocusSelector]);

  return {
    grabProps: {
      onTouchStart: (e) => {
        touchY.current = e.touches[0].clientY;
      },
      onTouchEnd: (e) => {
        if (touchY.current == null) return;
        const dy = e.changedTouches[0].clientY - touchY.current;
        touchY.current = null;
        if (dy > 70) setOpenRef.current(false);
      },
    },
  };
}
