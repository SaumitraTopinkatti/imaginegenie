import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { registerLayer } from "../lib/historyLayers";

/**
 * Shared accessible dialog shell (S2/S3/S13).
 *
 * One registration stack drives layered Escape: a single window capture
 * listener closes only the topmost dialog, so a viewer over a lightbox (or a
 * modal over anything) never closes the layer beneath. Each instance traps
 * Tab inside its panel, moves focus in on open, returns focus to the opener
 * on close, and marks the app root (`#root`, rendered via portal sibling)
 * inert while any dialog is open so keyboard and virtual cursors stay inside.
 *
 * Overlay click still closes (existing behaviour); the panel stops
 * propagation so only its own close path runs.
 */

interface StackEntry {
  close: () => void;
}

const stack: StackEntry[] = [];
let escAttached = false;

export function hasOpenDialog(): boolean {
  return stack.length > 0;
}

function syncInert(): void {
  const root = document.getElementById("root");
  if (!root) return;
  (root as HTMLElement & { inert?: boolean }).inert = stack.length > 0;
  // Class (not inline style): useBottomSheet clears body.style.overflow and
  // would clobber an inline lock set here.
  document.body.classList.toggle("dialog-open", stack.length > 0);
}

function onWindowKey(e: globalThis.KeyboardEvent): void {
  if (e.key !== "Escape" || stack.length === 0) return;
  // Capture at window fires before page bubble handlers; immediate-stop keeps
  // the app-level Escape handler (lightbox/drawer/menu) from also firing.
  e.stopImmediatePropagation();
  stack[stack.length - 1].close();
}

function ensureEscListener(): void {
  if (escAttached) return;
  escAttached = true;
  window.addEventListener("keydown", onWindowKey, true);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

export interface DialogProps {
  role?: "dialog" | "alertdialog";
  /** Accessible name when there is no labelled heading. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  onClose: () => void;
  /** Register a Back-to-close history entry (default true). Opt out for
      ephemeral layers that must never own an entry. */
  history?: boolean;
  /** Focused on open; defaults to the first focusable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Focused on close; defaults to the opener. Needed when the opener
      unmounts with the dialog launch (e.g. a menu item whose menu closes). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  overlayClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}

export default function Dialog({
  role = "dialog",
  label,
  labelledBy,
  describedBy,
  onClose,
  history = true,
  initialFocusRef,
  returnFocusRef,
  overlayClassName = "overlay overlay-top",
  panelClassName = "confirm-card",
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const returnRef = useRef(returnFocusRef);
  returnRef.current = returnFocusRef;

  useEffect(() => {
    ensureEscListener();
    const opener = document.activeElement as HTMLElement | null;
    const entry: StackEntry = { close: () => closeRef.current() };
    stack.push(entry);
    // Back closes this layer through the same onClose (focus/inert intact).
    // The history prop is mount-time only, like the rest of this effect.
    const unregister = history ? registerLayer(() => closeRef.current()) : () => {};
    syncInert();
    // Focus in: explicit target, else first control, else the panel itself.
    const panel = panelRef.current;
    const target =
      initialFocusRef?.current && panel?.contains(initialFocusRef.current)
        ? initialFocusRef.current
        : panel
          ? (focusables(panel)[0] ?? panel)
          : null;
    target?.focus({ preventScroll: true });
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      unregister();
      syncInert();
      // Focus return: explicit target first (opener unmounted with launch),
      // then the opener when still in the document (skipped when e.g. its
      // card was deleted — callers move focus to the region in that case).
      const ret = returnRef.current?.current;
      if (ret && document.contains(ret)) {
        try {
          ret.focus({ preventScroll: true });
          return;
        } catch {
          /* target refused focus; fall through to the opener */
        }
      }
      if (opener && document.contains(opener)) {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          /* opener refused focus; leave focus where it is */
        }
      }
    };
    // Mount/unmount only: opener + stack slot belong to this instance
    // (onClose runs through closeRef so the empty deps are intentional).
  }, []);

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusables(panel);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
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

  return createPortal(
    <div className={overlayClassName} onClick={onClose}>
      <div
        ref={panelRef}
        className={panelClassName}
        role={role}
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKey}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
