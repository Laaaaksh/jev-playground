// Local dev server only. Serves public/ as static files and routes
// POST /api/run to the same relay handler that runs on Vercel, so the
// behaviour (including headers and CSP) matches production. No dependencies.
//
// The owner's real API key is never read or used here - this is the
// "bring your own key" build, so every visitor (including you, locally)
// pastes their own key into the page.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { handleRun } from "../lib/relay.mjs";

const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT ?? 4747);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// Load vercel.json once at startup so the same security headers that apply
// in production also apply locally - lets you catch a CSP violation here
// instead of discovering it after deploy.
let extraHeaders = {};
try {
  const vercelConfig = JSON.parse(await readFile(path.join(__dirname, "vercel.json"), "utf8"));
  const rule = vercelConfig.headers?.find((h) => h.source === "/(.*)");
  if (rule) for (const { key, value } of rule.headers) extraHeaders[key] = value;
} catch (err) {
  console.error("Could not read vercel.json for local headers:", err?.name, err?.message);
}

function withSecurityHeaders(res, extra = {}) {
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

// Resolve a request path safely inside PUBLIC_DIR: reject any ".." segment
// and anything that normalizes outside the public directory, so a request
// like /../package.json can never read files outside public/.
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  if (decoded.includes("..")) return null;
  const rel = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.join(PUBLIC_DIR, rel);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) return null;
  return resolved;
}

async function serveStatic(req, res) {
  const filePath = safeResolve(req.url);
  if (!filePath) {
    withSecurityHeaders(res);
    res.writeHead(400).end("Bad request");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    withSecurityHeaders(res, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.writeHead(200).end(data);
  } catch {
    withSecurityHeaders(res);
    res.writeHead(404).end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/run") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const webRequest = new Request(`http://${req.headers.host}${req.url}`, {
        method: "POST",
        headers: req.headers,
        body,
      });
      const webResponse = await handleRun(webRequest);
      withSecurityHeaders(res);
      for (const [k, v] of webResponse.headers) res.setHeader(k, v);
      res.writeHead(webResponse.status);
      res.end(await webResponse.text());
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res);
    }
    withSecurityHeaders(res);
    res.writeHead(405).end("Method not allowed");
  } catch (err) {
    console.error("server error:", err?.name, err?.message);
    withSecurityHeaders(res);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Internal error" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Jev playground (bring your own key): http://localhost:${PORT}`);
});
