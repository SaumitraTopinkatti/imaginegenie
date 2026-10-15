// Mock OpenRouter API for e2e tests. Dependency-free node:http, loopback
// only, never forwards anywhere. `node e2e/mock-api/server.mjs [--port N]`
//
// Auth (mirrors the real provider): /images and /key return 401
//   {"error":{"message":"Missing Authentication header","code":401}} when the
//   bearer value is empty or doesn't start with sk-or-. Checked FIRST, so no
//   scenario or directive can bypass it.
// Scenario selection (priority order):
//   1. Prompt directive  [[mock:<scenario>[,key=value...]]] anywhere in the prompt
//   2. API key value     (sk-or-test-ok / -401 / -402 / -429 / -500 ...)
//   3. POST /__mock/scenario {scenario} global default (POST /__mock/reset clears)
// Control: GET /__mock/requests (log), DELETE /__mock/requests (clear).
// Key check: GET /api/v1/key -> {data:{label, limit_remaining}} (D23).
import { createServer } from "node:http";
import { pngBuffer } from "./png.mjs";

const PORT = Number(process.argv[2] || process.env.E2E_MOCK_PORT || 4191);
const COST = 0.045;

let globalScenario = "ok";
/** Parallel-safe counters keyed by scenario+params+prompt: tests use unique
 *  prompt markers, so fail-nth/fail-random counting never crosses tests. */
const counters = new Map();
const log = [];

const KEY_SCENARIOS = {
  "sk-or-test-ok": "ok",
  "sk-or-test-400": "400",
  "sk-or-test-401": "401",
  "sk-or-test-402": "402",
  "sk-or-test-404": "404",
  "sk-or-test-413": "413",
  "sk-or-test-429": "429",
  "sk-or-test-500": "500",
  "sk-or-test-502": "502",
};

const ERROR_MESSAGES = {
  400: "prompt blocked by safety filters",  401: "invalid api key",
  402: "insufficient credits",
  404: "no such endpoint",
  413: "payload too large",
  429: "rate limit exceeded, slow down",
  500: "provider exploded",
  502: "bad gateway upstream",
};

// Mirrors src/lib/models.ts Qwen caps so client bugs surface as real 400s.
const QWEN_ID = "qwen/qwen-image-3-pro-20260805";
const QWEN_ASPECTS = [
  "1:1", "1:2", "2:1", "2:3", "3:2", "3:4", "4:3", "4:5",
  "5:4", "9:16", "16:9",
];
const QWEN_MAX_REFS = 4;

function parseDirective(prompt) {
  const m = /\[\[mock:([^\]]+)\]\]/.exec(prompt || "");
  if (!m) return null;
  const parts = m[1].split(",").map((s) => s.trim());
  const out = { scenario: parts[0], params: {} };
  for (const p of parts.slice(1)) {
    const [k, v] = p.split("=");
    if (k) out.params[k.trim()] = v === undefined ? true : v.trim();
  }
  return out;
}

function keyKind(auth) {
  const m = /^Bearer\s+(.+)$/.exec(auth || "");
  const key = m ? m[1] : "";
  if (!key) return "missing";
  if (KEY_SCENARIOS[key]) return key;
  return "other";
}

/** Bearer value the client sent ("" when absent). Secret values never logged. */
function bearerKey(auth) {
  const m = /^Bearer\s+(.+)$/.exec(auth || "");
  return m ? m[1].trim() : "";
}

/** D25: empty or non-sk-or- bearer → 401, like the real provider. */
function authRejected(auth) {
  const key = bearerKey(auth);
  return key === "" || !key.startsWith("sk-or-");
}

function unauth(res, entry) {
  entry.scenario = "unauth";
  entry.via = "auth";
  send(res, 401, { error: { message: "Missing Authentication header", code: 401 } });
}

function scenarioFor(body, auth) {
  const d = parseDirective(body?.prompt);
  if (d) return { scenario: d.scenario, params: d.params, via: "directive" };
  const kk = keyKind(auth);
  if (KEY_SCENARIOS[kk]) return { scenario: KEY_SCENARIOS[kk], params: {}, via: "key" };
  return { scenario: globalScenario, params: {}, via: "global" };
}

function okBody(mediaType = "image/png", cost = COST) {
  // Aspect-labelled fixture: pick buffer by requested ratio when known.
  return {
    data: [{ b64_json: pngBuffer(96, 96, "gradient").toString("base64"), media_type: mediaType }],
    usage: cost === null ? undefined : { cost },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, obj, contentType = "application/json") {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "Authorization, Content-Type, HTTP-Referer, X-Title"
  );
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- control endpoints (no logging) ----
  if (url.pathname === "/__mock/scenario" && req.method === "POST") {
    try {
      const j = JSON.parse((await readBody(req, res)) || "{}");
      if (typeof j.scenario === "string") globalScenario = j.scenario;
    } catch {
      /* keep current */
    }
    send(res, 200, { scenario: globalScenario });
    return;
  }
  if (url.pathname === "/__mock/reset" && req.method === "POST") {
    globalScenario = "ok";
    counters.clear();
    log.length = 0;
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/__mock/requests" && req.method === "GET") {
    send(res, 200, { requests: log });
    return;
  }
  if (url.pathname === "/__mock/requests" && req.method === "DELETE") {
    log.length = 0;
    send(res, 200, { ok: true });
    return;
  }

  // ---- app endpoints ----
  let raw = "";
  try {
    raw = await readBody(req, res);
  } catch {
    return; // destroyed oversized body
  }
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { __unparsed: raw.slice(0, 200) };
  }
  const auth = req.headers.authorization || "";
  const headers = { ...req.headers };
  delete headers.authorization; // never log secret values

  const entry = {
    method: req.method,
    path: url.pathname,
    headers,
    body,
    scenario: "",
    via: "",
    keyKind: keyKind(auth),
    ts: Date.now(),
    aborted: false,
  };
  let logged = false;
  const pushLog = () => {
    if (!logged) {
      logged = true;
      log.push(entry);
    }
  };
  // Client disconnect (Cancel): res closes before the handler responds.
  res.on("close", () => {
    if (!res.writableEnded) {
      entry.aborted = true;
      pushLog();
    }
  });

  if (req.method === "POST" && url.pathname === "/api/v1/images") {
    if (authRejected(auth)) {
      unauth(res, entry);
      pushLog();
      return;
    }
    // Per-model provider caps (Qwen): reject over-cap refs / bad aspects like the real API.
    if (body?.model === QWEN_ID) {
      const refCount = Array.isArray(body?.input_references) ? body.input_references.length : 0;
      if (refCount > QWEN_MAX_REFS) {
        send(res, 400, { error: { message: "input_references: must have between 0 and 4 items", code: 400 } });
        pushLog();
        return;
      }
      if (!QWEN_ASPECTS.includes(body?.aspect_ratio)) {
        send(res, 400, { error: { message: `aspect_ratio: not supported (${body?.aspect_ratio})`, code: 400 } });
        pushLog();
        return;
      }
    }
    const { scenario, params, via } = scenarioFor(body, auth);
    const counterKey = `${scenario}|${JSON.stringify(params)}|${body?.prompt ?? ""}`;
    const n = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, n);
    entry.scenario = scenario;
    entry.via = via;
    const ms = Number(params.ms ?? 1500);

    const err = (status) =>
      send(res, status, { error: { message: ERROR_MESSAGES[status] || "error", code: status } });
    switch (scenario) {
      case "ok":
        send(res, 200, okBody());
        break;
      case "ok-webp":
        send(res, 200, okBody("image/webp"));
        break;
      case "ok-jpeg":
        send(res, 200, okBody("image/jpeg"));
        break;
      case "cost-missing":
        send(res, 200, { data: okBody().data });
        break;
      case "cost-high":
        send(res, 200, okBody("image/png", 0.5));
        break;
      case "delay":
        await sleep(Number.isFinite(ms) ? ms : 1500);
        if (!entry.aborted) send(res, 200, okBody());
        break;
      case "slow-abort":
        // Honor client disconnect: just wait; close-handler records the abort.
        await sleep(Number.isFinite(ms) ? ms : 8000);
        if (!entry.aborted) send(res, 200, okBody());
        break;
      case "fail-first":
      case "fail-nth": {
        const target = Number(params.n ?? 1);
        if (n === target) err(500);
        else send(res, 200, okBody());
        break;
      }
      case "fail-random-seeded": {
        const seed = Number(params.seed ?? 1);
        if ((n * 2654435761 + seed * 40503) % 4 === 0) err(500);
        else send(res, 200, okBody());
        break;
      }
      case "400":
      case "401":
      case "402":
      case "404":
      case "413":
      case "429":
      case "500":
      case "502":
        err(Number(scenario));
        break;
      case "html-error-body":
        send(res, 500, "<html><body>explode</body></html>", "text/html");
        break;
      case "invalid-json":
        send(res, 200, "this is not json {{{", "application/json");
        break;
      case "empty-data":
        send(res, 200, { data: [] });
        break;
      case "url-instead-of-b64":
        send(res, 200, { data: [{ url: "http://127.0.0.1:9/fake.png" }] });
        break;
      case "huge-payload":
        send(res, 200, { data: [{ b64_json: "A".repeat(8 * 1024 * 1024), media_type: "image/png" }], usage: { cost: COST } });
        break;
      case "socket-drop":
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":[{');
        await sleep(50);
        req.socket.destroy();
        break;
      case "dns-like":
        req.socket.destroy();
        break;
      default:
        err(500);
        break;
    }
    pushLog();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/key") {
    if (authRejected(auth)) {
      unauth(res, entry);
      pushLog();
      return;
    }
    const kk = keyKind(auth);
    entry.via = "key";
    if (KEY_SCENARIOS[kk] && KEY_SCENARIOS[kk] !== "ok") {
      const st = Number(KEY_SCENARIOS[kk]);
      entry.scenario = KEY_SCENARIOS[kk];
      pushLog();
      send(res, st, { error: { message: ERROR_MESSAGES[st] || "error", code: st } });
      return;
    }
    entry.scenario = "ok";
    pushLog();
    send(res, 200, { data: { label: "mock key", limit_remaining: 10 } });
    return;
  }

  pushLog();
  send(res, 404, { error: { message: "mock: unknown route", code: 404 } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-api: http://127.0.0.1:${PORT}/ (loopback only, no forwarding)`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
