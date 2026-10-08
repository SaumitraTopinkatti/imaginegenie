import fs from "node:fs";

const MODEL = "bytedance-seed/seedream-5-0-pro";
const MODEL_ENDPOINT_SLUG = "bytedance-seed/seedream-5-0-pro-20260812";
const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_IMAGES_URL = `${DEFAULT_BASE}/images`;
const ENDPOINTS_URL = `${DEFAULT_BASE}/images/models/${MODEL_ENDPOINT_SLUG}/endpoints`;

// tiny 1x1 transparent PNG
const TINY_1X1_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FALLBACK_REF_URL = "https://picsum.photos/512";

function maskKey(k) {
  if (!k) return "(missing)";
  if (k.length <= 8) return "***";
  return k.slice(0, 4) + "..." + k.slice(-4) + ` (len=${k.length})`;
}

function getAuth() {
  const key = process.env.openrouter_api_key || process.env.OPENROUTER_API_KEY || "";
  const customEndpoint = process.env.openrouter_endpoint || process.env.OPENROUTER_ENDPOINT || "";
  if (customEndpoint && customEndpoint.trim()) {
    console.log(`[info] $openrouter_endpoint secret value: ${customEndpoint.trim()}`);
    console.log(`[info] defaulting to ${DEFAULT_IMAGES_URL} (custom base URL logged only)`);
  } else {
    console.log(`[info] no custom $openrouter_endpoint set; using ${DEFAULT_IMAGES_URL}`);
  }
  console.log(`[info] using key: ${maskKey(key)}`);
  if (!key) {
    console.error("ERROR: $openrouter_api_key is missing in env.");
    process.exit(1);
  }
  return key;
}

function headers(key) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function modeEndpoints() {
  const key = getAuth();
  console.log(`[endpoints] GET ${ENDPOINTS_URL}`);
  const res = await fetch(ENDPOINTS_URL, { headers: headers(key) });
  const text = await res.text();
  console.log(`[endpoints] status: ${res.status}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }
  console.log(JSON.stringify(json, null, 2));
  // Focused summary
  try {
    const eps = json?.data?.endpoints ?? json?.endpoints ?? [];
    if (Array.isArray(eps)) {
      for (const ep of eps) {
        console.log("--- endpoint summary ---");
        console.log("model:", ep.model ?? ep.id ?? "?");
        console.log("supported_parameters.input_references:", JSON.stringify(ep.supported_parameters?.input_references ?? ep.supported_parameters ?? "(not found)"));
        console.log("pricing:", JSON.stringify(ep.pricing ?? "(none)"));
        console.log("max n / limit:", JSON.stringify(ep.limit ?? ep.max_n ?? "(not found)"));
      }
    } else {
      console.log("[summary] supported_parameters.input_references:", JSON.stringify(json?.data?.supported_parameters?.input_references ?? json?.supported_parameters?.input_references ?? "(not found)"));
    }
  } catch (e) {
    console.log("[summary] parse error:", e.message);
  }
}

async function postImages(body) {
  const key = getAuth();
  const res = await fetch(DEFAULT_IMAGES_URL, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON
  }
  return { status: res.status, text, json };
}

function saveB64(outPath, b64) {
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

async function modeText() {
  const body = {
    model: MODEL,
    prompt: "A tiny cozy cabin in a snowy forest at dusk, warm glowing windows, simple, 16:9",
    n: 1,
    aspect_ratio: "16:9",
    resolution: "1K",
  };
  console.log("[text] POST", DEFAULT_IMAGES_URL);
  console.log("[text] body:", JSON.stringify({ ...body, prompt: body.prompt.slice(0, 80) }));
  const { status, text, json } = await postImages(body);
  console.log(`[text] status: ${status}`);
  if (!json) {
    console.log(text.slice(0, 2000));
    return;
  }
  if (status >= 200 && status < 300) {
    const item = json?.data?.[0];
    const cost = json?.usage?.cost ?? json?.usage ?? "(no usage.cost)";
    console.log("[text] media_type:", item?.media_type ?? "(none)");
    console.log("[text] cost:", typeof cost === "object" ? JSON.stringify(cost) : cost);
    console.log("[text] full usage:", JSON.stringify(json?.usage ?? null));
    if (item?.b64_json) {
      const size = saveB64("output-text.png", item.b64_json);
      console.log(`[text] saved output-text.png (${size} bytes)`);
    } else if (item?.url) {
      console.log("[text] no b64_json, got url:", item.url);
    } else {
      console.log("[text] response:", JSON.stringify(json).slice(0, 2000));
    }
  } else {
    console.log("[text] error body:", text.slice(0, 4000));
  }
}

function resolveImageArg() {
  const idx = process.argv.indexOf("--image");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return FALLBACK_REF_URL;
}

function toRefUrl(input) {
  if (/^(https?:\/\/|data:)/i.test(input)) return input;
  // local path
  const buf = fs.readFileSync(input);
  const ext = input.split(".").pop()?.toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function modeRef() {
  const imgInput = resolveImageArg();
  console.log(`[ref] image input: ${imgInput.startsWith("data:") ? "data:... (len=" + imgInput.length + ")" : imgInput}`);
  let refUrl;
  try {
    refUrl = toRefUrl(imgInput);
  } catch (e) {
    console.error("[ref] failed to read local image:", e.message);
    process.exit(1);
  }
  const body = {
    model: MODEL,
    prompt: "Redraw this reference photo as a cozy watercolor illustration, keep composition, 16:9",
    n: 1,
    aspect_ratio: "16:9",
    resolution: "1K",
    input_references: [{ type: "image_url", image_url: { url: refUrl } }],
  };
  console.log("[ref] POST", DEFAULT_IMAGES_URL, "with 1 input_reference");
  const { status, text, json } = await postImages(body);
  console.log(`[ref] status: ${status}`);
  if (!json) {
    console.log(text.slice(0, 2000));
    return;
  }
  if (status >= 200 && status < 300) {
    const item = json?.data?.[0];
    const cost = json?.usage?.cost ?? json?.usage ?? "(no usage.cost)";
    console.log("[ref] media_type:", item?.media_type ?? "(none)");
    console.log("[ref] cost:", typeof cost === "object" ? JSON.stringify(cost) : cost);
    console.log("[ref] full usage:", JSON.stringify(json?.usage ?? null));
    if (item?.b64_json) {
      const size = saveB64("output-ref.png", item.b64_json);
      console.log(`[ref] saved output-ref.png (${size} bytes)`);
    } else if (item?.url) {
      console.log("[ref] no b64_json, got url:", item.url);
    } else {
      console.log("[ref] response:", JSON.stringify(json).slice(0, 2000));
    }
  } else {
    console.log("[ref] error body:", text.slice(0, 4000));
  }
}

async function modeLimitTest() {
  const refs = Array.from({ length: 15 }, () => ({
    type: "image_url",
    image_url: { url: TINY_1X1_DATA_URL },
  }));
  const body = {
    model: MODEL,
    prompt: "limit test, ignore",
    n: 1,
    aspect_ratio: "16:9",
    resolution: "1K",
    input_references: refs,
  };
  console.log("[limit-test] POST", DEFAULT_IMAGES_URL, "with 15 dummy input_references (tiny 1x1 reused)");
  const { status, text, json } = await postImages(body);
  console.log(`[limit-test] status: ${status}`);
  const out = json ? JSON.stringify(json).slice(0, 4000) : text.slice(0, 4000);
  console.log("[limit-test] body:", out);
  if (status >= 200 && status < 300) {
    console.log("[limit-test] UNEXPECTED success with 15 refs — check response for truncation.");
  } else {
    console.log("[limit-test] got expected error for 15 refs (proves limit).");
  }
}

const mode = process.argv[2];
switch (mode) {
  case "endpoints":
    await modeEndpoints();
    break;
  case "text":
    await modeText();
    break;
  case "ref":
    await modeRef();
    break;
  case "limit-test":
    await modeLimitTest();
    break;
  default:
    console.log("Usage: node poc.mjs <endpoints|text|ref|limit-test> [--image <path-or-url>]");
    process.exit(1);
}
