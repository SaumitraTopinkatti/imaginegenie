import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2] || 4174);
const DIR = normalize(join(ROOT, process.argv[3] || "dist/"));

// Repeatable production-CSP harness: serves dist/ with the header values from
// public/_headers so CSP-governed behavior (clipboard, connect-src, framing)
// can be verified locally. `vite preview` and the a11y gate do NOT apply
// those headers. The upgrade-insecure-requests token is dropped because this
// is plain http (it would force-upgrade subresources to https and break).
function headersFromFile() {
  const raw = readFileSync(join(ROOT, "public/_headers"), "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const m = /^  ([A-Za-z-]+):\s*(.*?)\s*$/.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    let v = m[2]
      .replace(/;?\s*upgrade-insecure-requests\s*;?/g, ";")
      .replace(/;;+/g, ";")
      .replace(/;$/, "")
      .trim();
    if (v) out[m[1]] = v;
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const HEADERS = headersFromFile();

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(DIR, path.slice(1)));
    if (!file.startsWith(DIR) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      ...HEADERS,
    });
    res.end(readFileSync(file));
  } catch {
    try {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
    } catch {
      /* noop */
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`csp-serve: ${DIR} at http://127.0.0.1:${PORT}/ (headers from public/_headers)`);
});
