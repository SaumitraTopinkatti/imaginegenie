import { useRef, type TouchEventHandler } from "react";

export interface SwipeDismissOpts {
  onDismiss: () => void;
  /** Evaluated at touchstart: swipe only starts when true (e.g. scroller at top). */
  canStart?: () => boolean;
  /** Downward travel in px that counts as a dismiss (default 70, sheet parity). */
  threshold?: number;
}

/**
 * Swipe-down-to-dismiss for dialog panels (touch only). Never calls
 * preventDefault, so pinch-zoom and native scroll stay intact; aborts on
 * multi-touch. Pair with `overscroll-behavior: contain` on the scroller so
 * Chrome pull-to-refresh can't fire mid-gesture.
 */
export function useSwipeDismiss({ onDismiss, canStart, threshold = 70 }: SwipeDismissOpts): {
  onTouchStart: TouchEventHandler;
  onTouchEnd: TouchEventHandler;
} {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const start = useRef<{ x: number; y: number } | null>(null);

  return {
    onTouchStart: (e) => {
      if (e.touches.length > 1) {
        start.current = null;
        return;
      }
      if (canStart && !canStart()) {
        start.current = null;
        return;
      }
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    },
    onTouchEnd: (e) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dy = t.clientY - s.y;
      const dx = Math.abs(t.clientX - s.x);
      if (dy > threshold && dy > 2 * dx) dismissRef.current();
    },
  };
}
