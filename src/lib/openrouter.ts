import { DEFAULT_MODEL, MODELS, modelFor } from "./models";

export const MODEL = MODELS.seedream.requestId;
export const MODEL_ENDPOINT_SLUG = "bytedance-seed/seedream-5-0-pro-20260812";
export const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export const ASPECT_RATIOS = [
  "1:1",
  "1:2",
  "2:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "9:21",
  "21:9",
  "auto",
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type Resolution = "1K" | "2K";

export interface GenerateParams {
  prompt: string;
  aspect_ratio: string;
  resolution: Resolution;
  refs: string[]; // data URLs or https URLs
  seed?: number;
  /** Provider request id; defaults to Seedream so old call sites are untouched. */
  model?: string;
}

export interface GenerateResult {
  b64: string;
  mediaType: string;
  cost: number;
  rawUsage: unknown;
}

function base(): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  return (env.VITE_OPENROUTER_BASE || DEFAULT_BASE).replace(/\/$/, "");
}

/**
 * Key hygiene (D24): pasted keys routinely carry a "Bearer " prefix, wrapping
 * quotes, or stray whitespace/newlines. Normalise at input and at use — warn
 * on a suspicious shape, never block (custom/test keys stay usable).
 */
export function normalizeApiKey(raw: string): string {
  // Peel layers: the quote often wraps the "Bearer " prefix
  // (`"Bearer sk-or-…"`), so strip quotes and prefix until stable.
  let k = (raw ?? "").trim();
  for (let i = 0; i < 3; i++) {
    const quoted =
      k.length >= 2 &&
      ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")));
    const bearer = /^bearer\s+/i.test(k);
    if (!quoted && !bearer) break;
    if (quoted) k = k.slice(1, -1).trim();
    k = k.replace(/^bearer\s+/i, "").trim();
  }
  return k.replace(/\s+/g, "");
}

/** Empty (nothing typed yet) never warns; anything else should start sk-or-. */
export function looksLikeOpenRouterKey(k: string): boolean {
  return k === "" || k.startsWith("sk-or-");
}

function friendlyError(status: number, bodyText: string): string {
  let detail = "";
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.message || "";
  } catch {
    detail = bodyText.slice(0, 300);
  }
  const d = detail ? ` — ${detail}` : "";
  if (status === 400) return `Request rejected (400). Check prompt, aspect ratio or references${d}.`;
  if (status === 401)
    return `Key rejected (401). Re-paste it from openrouter.ai/keys and check it's enabled${d}.`;
  if (status === 402) return `Insufficient balance (402). Top up OpenRouter credits${d}.`;
  if (status === 404) return `Model endpoint not found (404)${d}.`;
  if (status === 413) return `Images too large (413). Remove a reference or use smaller files${d}.`;
  if (status === 429) return `Rate limited (429). Wait a moment and retry${d}.`;
  if (status >= 500) return `Provider error (${status}). Retry in a bit${d}.`;
  return `Request failed (${status})${d}.`;
}

export async function generateImage(
  apiKey: string,
  params: GenerateParams,
  signal?: AbortSignal
): Promise<GenerateResult> {
  // Defensive: never send `Bearer ` with nothing (or junk) after it.
  const key = normalizeApiKey(apiKey);
  if (!key) throw new Error("Add your OpenRouter API key first (key button in the header).");
  const url = `${base()}/images`;
  // Model resolves per call (never a global) so parallel fan-out can't mix models.
  const caps = modelFor(params.model);
  if (!caps.seed && params.seed !== undefined && !Number.isNaN(params.seed)) {
    throw new Error(`${caps.label} does not support seeds. Clear the seed first. No request was sent.`);
  }
  const body: Record<string, unknown> = {
    model: params.model ?? MODELS[DEFAULT_MODEL].requestId,
    prompt: params.prompt,
    n: 1,
    aspect_ratio: params.aspect_ratio,
    resolution: params.resolution,
  };
  if (params.seed !== undefined && !Number.isNaN(params.seed)) body.seed = params.seed;
  if (params.refs.length > 0) {
    body.input_references = params.refs.map((u) => ({
      type: "image_url",
      image_url: { url: u },
    }));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": window.location.origin,
      "X-Title": "ImagineGenie",
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyError(res.status, text));
  let json: {
    data?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
    usage?: { cost?: number };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Unexpected response from provider (not JSON).");
  }
  const item = json?.data?.[0];
  const b64 = item?.b64_json || "";
  if (!b64) {
    if (item?.url) throw new Error("Provider returned a URL instead of image data. Try again.");
    throw new Error("Provider returned no image. Try again.");
  }
  const cost =
    typeof json?.usage?.cost === "number" ? json.usage.cost : 0;
  return {
    b64,
    mediaType: item?.media_type || "image/png",
    cost,
    rawUsage: json?.usage ?? null,
  };
}

export interface KeyInfo {
  /** Provider's label for the key (untrusted text — render as text). */
  label: string;
  limitRemaining: number | null;
}

/**
 * Truthful Test (D23): `GET /key` is authenticated, so only a key OpenRouter
 * accepts succeeds. Free, no generation. The model-endpoint probe stays out.
 */
export async function testKey(apiKey: string, signal?: AbortSignal): Promise<KeyInfo> {
  const key = normalizeApiKey(apiKey);
  if (!key) throw new Error("Add your OpenRouter API key first (key button in the header).");
  const res = await fetch(`${base()}/key`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": window.location.origin,
      "X-Title": "ImagineGenie",
    },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyError(res.status, text));
  try {
    const d = JSON.parse(text)?.data ?? {};
    return {
      label: typeof d?.label === "string" ? d.label.slice(0, 80) : "",
      limitRemaining: typeof d?.limit_remaining === "number" ? d.limit_remaining : null,
    };
  } catch {
    return { label: "", limitRemaining: null };
  }
}

export function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "••••••••";
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}
