/**
 * History-integrated layers (Back closes the topmost modal/sheet).
 *
 * Modal history entries are same-URL `pushState` entries tagged in
 * `history.state` (`{igBase, igLayer}`) — no query params (Inpaint owns
 * `?src=`), no hash (skip links own fragments), no new paths (no fallback /
 * CSP work). This module owns the only `popstate` listener and keeps the
 * entry depth equal to the open-layer count, so Back never needs an empty
 * press and programmatic closes consume their entry the same way.
 *
 * `history.back()`/`go()` resolve asynchronously via `popstate`, so any
 * `pushState`/`replaceState` issued while a traversal is pending is queued
 * and runs after settle — otherwise the queued write lands on (or wipes)
 * the wrong entry. Internal traversals never close layers and never run
 * route callbacks; only user pops that change `igBase` do.
 */

/** Tag carried by every history entry the app owns. */
interface IgState {
  /** Canonical URL (path + search) this entry belongs to. */
  igBase: string;
  /** Open-layer count at this entry: top entry's tag == live layer count. */
  igLayer: number;
}

interface Layer {
  close: () => void;
}

const layers: Layer[] = [];
const routeCbs = new Set<() => void>();
const urlQueue: Array<() => void> = [];
/** Canonical URL (path + search) the app considers current. */
let canonical = "";
/** An internal go()/back() traversal is awaiting its popstate. */
let pending = false;
let reconcileQueued = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function isIgState(s: unknown): s is IgState {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return typeof r.igBase === "string" && typeof r.igLayer === "number";
}

function locUrl(): string {
  return window.location.pathname + window.location.search;
}

function curState(): IgState | null {
  const s = window.history.state;
  return isIgState(s) ? s : null;
}

/** Live depth; defensively stamps a foreign entry so depth never lies. */
function depth(): number {
  const s = curState();
  if (s) return s.igLayer;
  window.history.replaceState({ igBase: canonical || locUrl(), igLayer: 0 } satisfies IgState, "");
  return 0;
}

function scheduleReconcile(): void {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    reconcile();
  });
}

/**
 * Push entries (same URL) or unwind until the entry depth matches the
 * open-layer count. Registration bursts within one commit (StrictMode
 * remounts, clear-step key swaps) net out here, so there is no churn.
 */
function reconcile(): void {
  if (pending) return;
  const want = layers.length;
  const have = depth();
  if (want > have) {
    const url = locUrl();
    for (let i = have + 1; i <= want; i++) {
      window.history.pushState({ igBase: canonical, igLayer: i } satisfies IgState, "", url);
    }
    return;
  }
  if (want < have) {
    pending = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    // A stuck traversal (intervention, dropped event) must not wedge the
    // queue forever: settle on a re-read and reconcile again.
    fallbackTimer = setTimeout(() => {
      pending = false;
      fallbackTimer = null;
      drainQueue();
      scheduleReconcile();
    }, 600);
    window.history.go(want - have);
  }
}

function drainQueue(): void {
  while (urlQueue.length > 0) urlQueue.shift()?.();
}

/** Run now, or after the in-flight traversal settles (FIFO). */
function runOrQueue(fn: () => void): void {
  if (pending) urlQueue.push(fn);
  else fn();
}

/** Current entry URL differs from canonical: rewrite it, keep its state. */
function enforceCanonical(): void {
  if (locUrl() === canonical) return;
  const s = curState();
  window.history.replaceState(
    { igBase: canonical, igLayer: s ? s.igLayer : 0 } satisfies IgState,
    "",
    canonical
  );
}

/** Close the top `n` layers through their own onClose (focus/inert intact). */
function closeTop(n: number): void {
  const victims = layers.slice(-n).reverse();
  for (const l of victims) {
    try {
      l.close();
    } catch {
      /* a refused close stays registered; reconcile re-pushes its entry */
    }
  }
}

function onPopState(): void {
  if (pending) {
    // Our own traversal landed: never close layers, never route.
    pending = false;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    enforceCanonical();
    drainQueue();
    scheduleReconcile();
    return;
  }
  const s = curState();
  if (!s || s.igBase !== canonical) {
    // User changed route (or came back from off-app): drop every layer so a
    // modal never survives its page, then run the route callbacks.
    canonical = locUrl();
    closeTop(layers.length);
    for (const cb of [...routeCbs]) {
      try {
        cb();
      } catch {
        /* route handling must not die on one bad listener */
      }
    }
    scheduleReconcile();
    return;
  }
  if (s.igLayer < layers.length) {
    closeTop(layers.length - s.igLayer);
  } else if (s.igLayer > layers.length) {
    // Stale entry (forward into a closed modal, reload residue): unwind
    // silently instead of reopening anything.
    pending = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      pending = false;
      fallbackTimer = null;
      drainQueue();
      scheduleReconcile();
    }, 600);
    window.history.go(layers.length - s.igLayer);
    return;
  }
  enforceCanonical();
  // A refused close leaves layers.length above the entry: re-push it.
  scheduleReconcile();
}

/**
 * Register an open layer. Returns unregister. Order is z-order: the last
 * registered is the topmost. Entries are interchangeable, so closing a
 * middle layer by code is fine.
 */
export function registerLayer(close: () => void): () => void {
  const layer: Layer = { close };
  layers.push(layer);
  scheduleReconcile();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    scheduleReconcile();
  };
}

/** Route change: unwind open layers first, then push the new URL (depth 0). */
export function navigate(url: string, opts?: { replace?: boolean }): void {
  runOrQueue(() => {
    if (!opts?.replace && depth() > 0) {
      pending = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        pending = false;
        fallbackTimer = null;
        drainQueue();
        scheduleReconcile();
      }, 600);
      urlQueue.push(() => doNavigate(url, opts));
      window.history.go(-depth());
      return;
    }
    doNavigate(url, opts);
  });
}

function doNavigate(url: string, opts?: { replace?: boolean }): void {
  canonical = url;
  if (opts?.replace) {
    window.history.replaceState({ igBase: url, igLayer: 0 } satisfies IgState, "", url);
    return;
  }
  // Same-URL check at execution time: the unwind above may have landed home.
  if (locUrl() === url && depth() === 0) return;
  window.history.pushState({ igBase: url, igLayer: 0 } satisfies IgState, "", url);
}

/** Same entry, new canonical URL (e.g. Inpaint `?src=` updates); state kept. */
export function replaceUrl(url: string): void {
  runOrQueue(() => {
    canonical = url;
    const s = curState();
    window.history.replaceState(
      { igBase: url, igLayer: s ? s.igLayer : 0 } satisfies IgState,
      "",
      url
    );
  });
}

/** Fires only for user pops that change igBase (real route changes). */
export function onRoutePop(cb: () => void): () => void {
  routeCbs.add(cb);
  return () => {
    routeCbs.delete(cb);
  };
}

/** Stamp the boot entry and attach the single popstate listener. */
export function initHistoryLayers(): void {
  const url = locUrl();
  canonical = url;
  const s = curState();
  if (!s || s.igLayer !== 0) {
    window.history.replaceState(
      { igBase: s && s.igBase === url ? s.igBase : url, igLayer: 0 } satisfies IgState,
      ""
    );
    canonical = url;
  } else {
    canonical = s.igBase;
  }
  if (!listening) {
    listening = true;
    window.addEventListener("popstate", onPopState);
  }
}
