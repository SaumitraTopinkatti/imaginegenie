import { useEffect, useRef } from "react";
import { registerLayer } from "./historyLayers";

/**
 * Join a non-Dialog open state (sheet, drawer) to Back-to-close history.
 * Registration bursts within one commit (desktop auto-close) net out in the
 * module's microtask reconcile, so no entry is pushed for them.
 */
export function useHistoryLayer(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    return registerLayer(() => closeRef.current());
  }, [open]);
}
