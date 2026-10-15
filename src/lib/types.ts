/** Shared library types (moved out of App.tsx so tabs share one contract). */

export interface InpaintMeta {
  /** User's raw instruction text (what the UI shows and searches). */
  instruction: string;
  /** Where the inpaint source image came from. */
  source: "generation" | "reference" | "image";
  /** Library id of the source generation/reference, when applicable. */
  sourceId?: string;
  /** Knob state at send time: original sent alongside the marked copy. */
  includedOriginal: boolean;
  /** D8 pixel-preserving composite applied around the mask. */
  composited: boolean;
}

export interface Generation {
  id: string;
  createdAt: number;
  /** Exact prompt sent to the provider (for inpaint: the wrapped prompt). */
  prompt: string;
  aspectRatio: string;
  resolution: string;
  cost: number;
  mediaType: string;
  refCount: number;
  seed?: number;
  imageUrl: string;
  thumbUrl: string;
  refUrls: string[];
  /** Present on inpaint results; ordinary records omit it. */
  inpaint?: InpaintMeta;
  /** Provider request id; absent = Seedream (optional so old rows read unchanged). */
  model?: string;
}

/** Image chosen as an inpaint source (picker, lightbox or viewer entry). */
export interface InpaintSource {
  url: string;
  kind: "generation" | "reference" | "image";
  id?: string;
  label: string;
}
