// Relay between the browser and TypeSafe's Jev API.
//
// The visitor supplies their own TypeSafe API key via the Authorization
// header on each request. We never store it anywhere (no module-scope
// variable, no log line, no echo back in a response) - it only ever lives
// inside this function call, for the duration of the upstream fetch.
//
// This exists because TypeSafe blocks browser CORS from other origins, so
// a same-origin server has to sit in the middle and forward the request.

const UPSTREAM_URL = "https://api.typesafe.ai/v1/systemone"; // hard-coded on purpose: never take a URL from the request

const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const KEY_PATTERN = /^[\x21-\x7E]{8,256}$/; // printable ASCII, 8-256 chars - matches typical API key shapes without being TypeSafe-specific

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1000]; // backoff between attempt 1->2 and 2->3
const RETRYABLE_STATUS = new Set([429, 529]);
const MAX_HONOURED_RETRY_AFTER_MS = 5000;

// Best-effort, per-instance, in-memory rate limit. On serverless this resets
// per cold start / per instance, so it is a courtesy speed bump, not a hard
// guarantee - real abuse protection should sit in front of this (e.g. a
// platform-level WAF or Vercel's own rate limiting). Comment kept here so a
// future reader doesn't mistake this for a durable limiter.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_MAX_IPS = 10_000; // cap so the map can't grow unbounded under a spoofed-IP flood

/** @type {Map<string, number[]>} ip -> sorted array of request timestamps (ms) within the window */
const rateLimitBuckets = new Map();

function pruneRateLimitBuckets(now) {
  for (const [ip, timestamps] of rateLimitBuckets) {
    const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateLimitBuckets.delete(ip);
    else rateLimitBuckets.set(ip, fresh);
  }
  // Guard: if something is still spoofing distinct IPs faster than they age
  // out, drop the oldest entries so memory stays bounded no matter what.
  if (rateLimitBuckets.size > RATE_LIMIT_MAX_IPS) {
    const excess = rateLimitBuckets.size - RATE_LIMIT_MAX_IPS;
    let i = 0;
    for (const ip of rateLimitBuckets.keys()) {
      if (i++ >= excess) break;
      rateLimitBuckets.delete(ip);
    }
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  pruneRateLimitBuckets(now);
  const timestamps = (rateLimitBuckets.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    const oldest = timestamps[0];
    const retryAfterMs = Math.max(0, RATE_LIMIT_WINDOW_MS - (now - oldest));
    rateLimitBuckets.set(ip, timestamps);
    return { ok: false, retryAfterMs };
  }
  timestamps.push(now);
  rateLimitBuckets.set(ip, timestamps);
  return { ok: true };
}

function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle a POST /api/run request. Takes and returns Web-standard Request/Response
 * objects so the same function works unchanged on Vercel's Node functions and
 * in the local dev server.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleRun(request) {
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // Same-origin check: only this site's own front end may use the relay.
  // Stops other websites from pointing their JS at our relay as a free CORS
  // bypass to TypeSafe (which would burn visitors' keys against limits they
  // didn't set and could be used to mask the true caller).
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return json(403, { error: "Forbidden" });
    }
    const requestHost = new URL(request.url).host;
    if (originHost !== requestHost) {
      return json(403, { error: "Forbidden" });
    }
  }

  // Key comes only from the visitor's own Authorization header, per request.
  // It is read into a local variable and never assigned anywhere outside
  // this function's scope, never logged, and never included in any response.
  const authHeader = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  const key = match?.[1];
  if (!key || !KEY_PATTERN.test(key)) {
    return json(401, { error: "Paste your Jev API key" });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    return json(413, { error: "Request body is too large" });
  }

  let bodyText;
  try {
    bodyText = await request.text();
  } catch {
    return json(400, { error: "Could not read request body" });
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return json(413, { error: "Request body is too large" });
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return json(400, { error: "Request body is not valid JSON" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, { error: "Request body must be a JSON object" });
  }

  const ip = clientIp(request);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return json(429, { error: "Too many requests, please slow down" }, { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) });
  }

  const started = Date.now();
  const result = await callUpstream(bodyText, key);
  const elapsed = Date.now() - started;

  if (result.error) {
    // Never include the underlying error detail (could theoretically leak
    // network/env info); log only the safe bits.
    console.error("relay upstream failure:", result.errorName, result.errorMessage);
    return json(502, { error: "Could not reach TypeSafe" }, { "X-Elapsed-Ms": String(elapsed) });
  }

  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Elapsed-Ms": String(elapsed) };
  const retryAfter = result.response.headers.get("retry-after");
  if (retryAfter) headers["retry-after"] = retryAfter;

  return new Response(result.text, { status: result.response.status, headers });
}

async function callUpstream(bodyText, key) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: bodyText,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        return { error: true, errorName: err?.name ?? "Error", errorMessage: err?.message ?? "network error" };
      }
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 1000);
      continue;
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfterMsHeader = res.headers.get("retry-after-ms");
      const retryAfterMs = retryAfterMsHeader ? Number(retryAfterMsHeader) : null;
      const delay =
        retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs <= MAX_HONOURED_RETRY_AFTER_MS
          ? retryAfterMs
          : RETRY_DELAYS_MS[attempt - 1] ?? 1000;
      await sleep(delay);
      continue;
    }

    const text = await res.text();
    return { error: false, response: res, text };
  }
  // Unreachable in practice (loop always returns), but keeps the function total.
  return { error: true, errorName: "Error", errorMessage: "exhausted retries" };
}
