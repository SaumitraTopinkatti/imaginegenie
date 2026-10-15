/**
 * Per-model capabilities table: the single source of truth for model
 * knowledge (aspects, ref caps, prices, request ids). Seedream 5.0 Pro is
 * the default; Qwen Image 3 Pro rides alongside. Pure and DOM-free so
 * Playwright can import it directly in a unit spec.
 *
 * Qwen caps per parked PoC (poc-models-parked.md) + live aspect probes
 * (2026-10-16: 1:2/2:1 200, 9:21/21:9/9:19.5 400): res 1K|2K, 11 aspects
 * (no auto/phone or ultrawide ratios), refs 0-4, seed OK,
 * $0.04/1K $0.075/2K +$0.003/ref.
 */

export type ModelId = "seedream" | "qwen";

export interface ModelCaps {
  id: ModelId;
  /** Provider request id sent as `model` in POST /images. */
  requestId: string;
  /** Full label (lightbox stat). */
  label: string;
  /** Short label (card tag, search). */
  short: string;
  aspects: readonly string[];
  /** 8 entries driving the shape grid layout. */
  mainAspects: readonly string[];
  maxRefs: number;
  price: { "1K": number; "2K": number; perRef: number };
  seed: boolean;
}

export const MODELS: Record<ModelId, ModelCaps> = {
  seedream: {
    id: "seedream",
    requestId: "bytedance-seed/seedream-5-0-pro",
    label: "Seedream 5.0 Pro",
    short: "Seedream",
    aspects: [
      "1:1", "1:2", "2:1", "2:3", "3:2", "3:4", "4:3", "4:5",
      "5:4", "9:16", "16:9", "9:19.5", "19.5:9", "9:20", "20:9",
      "9:21", "21:9", "auto",
    ],
    mainAspects: ["auto", "1:1", "4:5", "3:4", "9:16", "16:9", "3:2", "21:9"],
    maxRefs: 14,
    price: { "1K": 0.045, "2K": 0.09, perRef: 0.003 },
    seed: true,
  },
  qwen: {
    id: "qwen",
    // Per PoC the probed slug is qwen/qwen-image-3-pro-20260805; whether the
    // provider also accepts a plain id is unverified — do not probe without OK.
    requestId: "qwen/qwen-image-3-pro-20260805",
    label: "Qwen Image 3 Pro",
    short: "Qwen",
    aspects: [
      "1:1", "1:2", "2:1", "2:3", "3:2", "3:4", "4:3", "4:5",
      "5:4", "9:16", "16:9",
    ],
    // `auto` swapped for `2:3` so the 8-slot grid keeps its layout.
    mainAspects: ["1:1", "2:3", "4:5", "3:4", "9:16", "16:9", "3:2", "21:9"],
    maxRefs: 4,
    price: { "1K": 0.04, "2K": 0.075, perRef: 0.003 },
    seed: true,
  },
};

export const DEFAULT_MODEL: ModelId = "seedream";

/** Unknown/undefined request ids read as Seedream (legacy rows have no model). */
export function modelFor(requestId?: string): ModelCaps {
  if (requestId !== undefined) {
    for (const m of Object.values(MODELS)) {
      if (m.requestId === requestId) return m;
    }
    // Short-label match so gallery search and future callers can resolve either form.
    const q = requestId.trim().toLowerCase();
    for (const m of Object.values(MODELS)) {
      if (m.short.toLowerCase() === q || m.id === q) return m;
    }
  }
  return MODELS.seedream;
}

/**
 * Nearest supported ratio to a w/h pair, compared in log space so 1:2 and
 * 2:1 are symmetric. Used for model-switch snaps ("auto" has no numeric
 * ratio — callers map it to 1:1 first).
 */
export function nearestSupportedAspect(w: number, h: number, aspects: readonly string[]): string {
  const target = w > 0 && h > 0 ? w / h : 1;
  const logTarget = Math.log(target);
  let best = aspects.includes("1:1") ? "1:1" : (aspects[0] ?? "1:1");
  let bestDist = Infinity;
  for (const label of aspects) {
    const parts = label.split(":");
    if (parts.length !== 2) continue;
    const n = Number(parts[0]);
    const d = Number(parts[1]);
    if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) continue;
    const dist = Math.abs(Math.log(n / d) - logTarget);
    if (dist < bestDist) {
      bestDist = dist;
      best = label;
    }
  }
  return best;
}
