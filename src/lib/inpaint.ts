/**
 * Inpaint prompt contract (D4) + helpers. Pure and DOM-free so Playwright
 * can import it directly in a unit spec.
 *
 * There is no mask parameter on the Seedream endpoint (D6): inpainting is
 * instruction editing over a visually marked reference. The red overlay is
 * only a selection marker — the prompt must say so explicitly, in the same
 * colour/alpha the editor exports (shared constants below).
 */
import { ASPECT_RATIOS } from "./openrouter";

/** Pure red selection marker, painted opaque offscreen (D2). */
export const MASK_COLOR = "#FF0000";
/** Translucency applied only when displaying/exporting the marked copy. */
export const MASK_ALPHA = 0.5;
/** Long-side working-grid cap (D3). */
export const INPAINT_MAX_DIM = 2048;
/** Instruction cap enforced by UI counter + normalizer. */
export const MAX_INSTRUCTION = 1000;
/** Cost constants mirror the provider pricing used in App (1K/2K + per-ref). */
export const INPAINT_PRICE_1K = 0.045;
export const INPAINT_PRICE_2K = 0.09;
export const INPAINT_PRICE_PER_REF = 0.003;

/** Trim + collapse whitespace + cap. Never mangle: no [[...]] stripping
 *  (e2e mock directives ride inside the instruction verbatim). */
export function normalizeInstruction(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_INSTRUCTION);
}

export interface InpaintPromptInput {
  instruction: string;
  /** True (default): [original, marked]. False: [marked] only (the knob). */
  includeOriginal: boolean;
}

/**
 * Wrap the user's instruction in the inpainting prompt. Variant A names two
 * images by role AND order (D4/D5); variant B names one and explains the
 * tint. The instruction is embedded verbatim between «».
 */
export function buildInpaintPrompt(input: InpaintPromptInput): string {
  const instruction = normalizeInstruction(input.instruction);
  if (input.includeOriginal) {
    return (
      "INPAINTING EDIT. Two images of the same scene with identical framing are attached: " +
      "first, the clean original image; second, a copy of it where one or more areas are covered " +
      `by a semi-transparent pure red (${MASK_COLOR}) overlay. The red overlay is only a selection ` +
      "marker — it is not part of the scene. " +
      "Apply the user's instruction ONLY inside the red-marked area and return the edited clean image. " +
      "\u201Cthis\u201D, \u201Cit\u201D, \u201Cthat\u201D, \u201Cthese\u201D, \u201Chere\u201D in the instruction " +
      "refer to whatever lies under the red overlay (clearly visible, untinted, in the clean original). " +
      "Outside the red area, keep the clean original exactly: same composition, framing, camera angle, " +
      "subjects, colours, lighting, text and fine detail. Do not crop, zoom, shift or restyle. " +
      "Inside the area, blend seamlessly: match perspective, scale, lighting, shadows, reflections, " +
      "texture, grain and art style. " +
      "If the instruction modifies the marked thing (colour, material, finish), keep its shape and identity; " +
      "if it names something new, replace it; if it asks to remove, continue the surrounding background naturally. " +
      "The result must contain no red overlay, tint, outline or marks. " +
      `User instruction: \u00AB${instruction}\u00BB`
    );
  }
  return (
    "INPAINTING EDIT. One image is attached: a scene where one or more areas are covered " +
    `by a semi-transparent pure red (${MASK_COLOR}) overlay. The red overlay is only a selection ` +
    "marker — it is not part of the scene; the content underneath stays visible through the tint. " +
    "Apply the user's instruction ONLY inside the red-marked area and return the edited image with " +
    "the overlay gone. " +
    "\u201Cthis\u201D, \u201Cit\u201D, \u201Cthat\u201D, \u201Cthese\u201D, \u201Chere\u201D in the instruction " +
    "refer to whatever lies under the red overlay. " +
    "Outside the red area, keep the image exactly: same composition, framing, camera angle, " +
    "subjects, colours, lighting, text and fine detail. Do not crop, zoom, shift or restyle. " +
    "Unchanged parts of the marked area must keep their underlying content with the tint removed. " +
    "Inside the area, blend seamlessly: match perspective, scale, lighting, shadows, reflections, " +
    "texture, grain and art style. " +
    "If the instruction modifies the marked thing (colour, material, finish), keep its shape and identity; " +
    "if it names something new, replace it; if it asks to remove, continue the surrounding background naturally. " +
    "The result must contain no red overlay, tint, outline or marks. " +
    `User instruction: \u00AB${instruction}\u00BB`
  );
}

function ratioValue(label: string): number | null {
  const parts = label.split(":");
  if (parts.length !== 2) return null;
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

/**
 * Nearest supported ratio to the source dimensions (D7, never auto).
 * Compared in log space so 1:2 and 2:1 are symmetric. Also returns the
 * relative error for the >3% aspect-mismatch notice.
 */
export function nearestAspect(w: number, h: number): { ratio: string; error: number } {
  const target = w / h;
  const logTarget = Math.log(target);
  let best = "1:1";
  let bestDist = Infinity;
  for (const label of ASPECT_RATIOS) {
    if (label === "auto") continue;
    const v = ratioValue(label);
    if (v === null) continue;
    const d = Math.abs(Math.log(v) - logTarget);
    if (d < bestDist) {
      bestDist = d;
      best = label;
    }
  }
  const bestValue = ratioValue(best) ?? 1;
  return { ratio: best, error: Math.abs(bestValue - target) / target };
}

/** Button estimate: resolution price + $0.003 per sent reference. */
export function inpaintCost(resolution: "1K" | "2K", refCount: number): number {
  return (resolution === "2K" ? INPAINT_PRICE_2K : INPAINT_PRICE_1K) + refCount * INPAINT_PRICE_PER_REF;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

/**
 * Pixel-preserving composite (D8): the saved image is the original outside
 * the mask and the model output inside a dilated + feathered mask. The model
 * always re-renders the whole frame, so without this colour/detail drift
 * outside the mask is unavoidable.
 *
 * `originalUrl`/`outputUrl` are data URLs; `mask` is the opaque-red binary
 * mask at the working grid (same dimensions as the original export).
 */
export async function compositeInpaint(
  originalUrl: string,
  outputUrl: string,
  mask: HTMLCanvasElement,
  opts?: { dilateFrac?: number; featherPx?: number }
): Promise<string> {
  const [original, output] = await Promise.all([loadImage(originalUrl), loadImage(outputUrl)]);
  const W = original.naturalWidth || mask.width;
  const H = original.naturalHeight || mask.height;
  const short = Math.min(W, H);
  const dilateR = Math.max(1, Math.round(short * (opts?.dilateFrac ?? 0.0125)));
  const feather = Math.max(1, Math.round(opts?.featherPx ?? Math.max(2, short * 0.004)));

  // 1. Dilate: union of 8 shifted copies so the model's blended edge is inside.
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sctx = src.getContext("2d");
  if (!sctx) throw new Error("Canvas not available.");
  // Mask may differ in size from the export grid: normalize first.
  sctx.drawImage(mask, 0, 0, W, H);
  const dilated = document.createElement("canvas");
  dilated.width = W;
  dilated.height = H;
  const dctx = dilated.getContext("2d");
  if (!dctx) throw new Error("Canvas not available.");
  dctx.drawImage(src, 0, 0);
  dctx.globalCompositeOperation = "lighten";
  const steps: Array<[number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  for (const [dx, dy] of steps) dctx.drawImage(src, dx * dilateR, dy * dilateR);
  dctx.globalCompositeOperation = "source-over";

  // 2. Feather. ctx.filter=blur where supported; downscale/upscale fallback
  // (older Safari) which softens via smoothing.
  const feathered = document.createElement("canvas");
  feathered.width = W;
  feathered.height = H;
  const fctx = feathered.getContext("2d");
  if (!fctx) throw new Error("Canvas not available.");
  if (typeof (fctx as CanvasRenderingContext2D & { filter?: unknown }).filter === "string") {
    fctx.filter = `blur(${feather}px)`;
    fctx.drawImage(dilated, 0, 0);
    fctx.filter = "none";
  } else {
    const tiny = document.createElement("canvas");
    const tw = Math.max(1, Math.round(W / (feather * 2)));
    const th = Math.max(1, Math.round(H / (feather * 2)));
    tiny.width = tw;
    tiny.height = th;
    tiny.getContext("2d")?.drawImage(dilated, 0, 0, tw, th);
    fctx.imageSmoothingEnabled = true;
    fctx.drawImage(tiny, 0, 0, W, H);
  }

  // 3. Output clipped to the feathered mask, drawn over the original.
  const clipped = document.createElement("canvas");
  clipped.width = W;
  clipped.height = H;
  const cctx = clipped.getContext("2d");
  if (!cctx) throw new Error("Canvas not available.");
  cctx.drawImage(output, 0, 0, W, H);
  cctx.globalCompositeOperation = "destination-in";
  cctx.drawImage(feathered, 0, 0);

  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("Canvas not available.");
  octx.drawImage(original, 0, 0, W, H);
  octx.drawImage(clipped, 0, 0);
  return out.toDataURL("image/jpeg", 0.92);
}
