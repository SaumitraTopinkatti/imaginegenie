/**
 * Library helpers shared by Studio and Inpaint (N2 plumbing).
 * Studio's `doGenerate` save block is deliberately NOT refactored —
 * Inpaint gets its own small save helper modelled on it.
 */
import {
  decryptReference,
  decryptText,
  encryptText,
  listRawReferences,
  saveRecord,
  uid,
} from "./secureStore";
import type { Generation } from "./types";
import { makeThumb } from "./images";

export interface SaveGenerationInput {
  /** Final result image as a data URL (composited or raw model output). */
  imageUrl: string;
  /** Exact prompt sent to the provider. */
  prompt: string;
  aspectRatio: string;
  resolution: string;
  cost: number;
  mediaType: string;
  /** Reference data URLs actually sent. */
  refUrls: string[];
  seed?: number;
  inpaint?: Generation["inpaint"];
}

/** Encrypt image/thumb/refs, store the record, return the Generation. */
export async function saveGeneration(input: SaveGenerationInput): Promise<Generation> {
  let thumb = input.imageUrl;
  try {
    thumb = await makeThumb(input.imageUrl);
  } catch {
    thumb = input.imageUrl;
  }
  const [imageEnc, thumbEnc, refsEnc] = await Promise.all([
    encryptText(input.imageUrl),
    encryptText(thumb),
    Promise.all(input.refUrls.map((u) => encryptText(u))),
  ]);
  const gen: Generation = {
    id: uid(),
    createdAt: Date.now(),
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    cost: input.cost,
    mediaType: input.mediaType,
    refCount: input.refUrls.length,
    seed: input.seed,
    imageUrl: input.imageUrl,
    thumbUrl: thumb,
    refUrls: [...input.refUrls],
    inpaint: input.inpaint,
  };
  await saveRecord({
    id: gen.id,
    createdAt: gen.createdAt,
    prompt: gen.prompt,
    aspectRatio: gen.aspectRatio,
    resolution: gen.resolution,
    cost: gen.cost,
    mediaType: gen.mediaType,
    refCount: gen.refCount,
    seed: gen.seed,
    imageEnc,
    thumbEnc,
    refsEnc,
    inpaint: gen.inpaint,
  });
  return gen;
}

export interface ReferenceThumb {
  id: string;
  name: string;
  group: string;
  thumbUrl: string;
}

/**
 * Thumbs only (plus id/name/group) for the source picker: decrypting every
 * full reference just to show a picker grid would be wasteful.
 */
export async function listReferenceThumbs(): Promise<ReferenceThumb[]> {
  const raw = await listRawReferences();
  const out: ReferenceThumb[] = [];
  for (const r of raw) {
    let thumbUrl: string;
    try {
      thumbUrl = await decryptText(r.thumbEnc);
    } catch {
      // Corrupt thumbnail falls back to the full image (same as decryptReference).
      thumbUrl = (await decryptReference(r)).imageUrl;
    }
    out.push({ id: r.id, name: r.name, group: r.group, thumbUrl });
  }
  return out;
}

/** Full image for one reference, decrypted on pick. */
export async function loadReferenceImage(id: string): Promise<string> {
  const raw = await listRawReferences();
  const row = raw.find((r) => r.id === id);
  if (!row) throw new Error("Reference not found.");
  return decryptText(row.imageEnc);
}
