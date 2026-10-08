export const MODEL = "bytedance-seed/seedream-5-0-pro";
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
  if (status === 401) return `Invalid API key (401). Paste a valid OpenRouter key${d}.`;
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
  const url = `${base()}/images`;
  const body: Record<string, unknown> = {
    model: MODEL,
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
      Authorization: `Bearer ${apiKey}`,
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

export async function testKey(apiKey: string, signal?: AbortSignal): Promise<string> {
  const url = `${base()}/images/models/${MODEL_ENDPOINT_SLUG}/endpoints`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": window.location.origin,
      "X-Title": "ImagineGenie",
    },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyError(res.status, text));
  try {
    const j = JSON.parse(text);
    const eps = j?.data?.endpoints ?? j?.endpoints;
    if (Array.isArray(eps) && eps.length > 0) {
      const pricing = eps[0]?.pricing;
      const price = pricing ? JSON.stringify(pricing) : "ok";
      return `Connected — ${eps.length} endpoint(s). Pricing: ${price}`.slice(0, 220);
    }
    return "Connected — model endpoint reachable.";
  } catch {
    return "Connected — model endpoint reachable.";
  }
}

export function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "••••••••";
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}
