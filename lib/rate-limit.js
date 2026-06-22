// ─────────────────────────────────────────
// In-process rate limiter for auth endpoints
//
// Vercel serverless functions are single-threaded and handle one request at
// a time per instance, so a module-level Map is safe — no locking needed.
// This is per-instance (not cross-fleet), which means an attacker with many
// IPs can rotate across cold instances, but it still stops the common case:
// a single IP hammering one warm instance with brute-force or signup spam.
//
// For a stronger guarantee, replace the Map with a Turso/KV atomic counter.
// The interface here is drop-in compatible: swap _store below, keep the
// checkRateLimit export signature unchanged.
// ─────────────────────────────────────────

// { key → { count, windowStart } }
const _store = new Map();

// Remove expired entries to keep the Map from growing indefinitely on a
// long-lived instance. Called on every check rather than on a timer so
// this module stays dependency-free.
function _prune(nowMs, windowMs) {
  for (const [key, entry] of _store) {
    if (nowMs - entry.windowStart >= windowMs) _store.delete(key);
  }
}

/**
 * Check whether `key` has exceeded `limit` hits within a rolling `windowMs`
 * window. Increments the counter and returns:
 *   { allowed: true }  — request is within quota
 *   { allowed: false, retryAfterMs: number } — over quota; ms until reset
 *
 * @param {string} key       - Arbitrary bucket key, e.g. the client IP.
 * @param {number} limit     - Maximum hits allowed in the window.
 * @param {number} windowMs  - Window size in milliseconds.
 */
export function checkRateLimit(key, limit, windowMs) {
  const nowMs = Date.now();

  // Prune expired entries on every call (cheap — Map iteration is O(n) but
  // the store stays small for auth endpoints that see low cardinality IPs).
  _prune(nowMs, windowMs);

  let entry = _store.get(key);

  // Start a fresh window if this key is new or its window has elapsed.
  if (!entry || nowMs - entry.windowStart >= windowMs) {
    entry = { count: 0, windowStart: nowMs };
    _store.set(key, entry);
  }

  entry.count += 1;

  if (entry.count > limit) {
    const retryAfterMs = windowMs - (nowMs - entry.windowStart);
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  return { allowed: true };
}

/**
 * Convenience helper that reads the client IP from a Vercel/Node request
 * object and calls checkRateLimit, then writes the 429 response if blocked.
 * Returns true if the request is allowed, false if it was rate-limited
 * (caller should return immediately after a false result).
 *
 * @param {object} req
 * @param {object} res
 * @param {{ limit: number, windowMs: number }} opts
 */
export function enforceRateLimit(req, res, { limit, windowMs }) {
  // Vercel forwards the real client IP in x-forwarded-for. Fall back to
  // remoteAddress for local dev (vercel dev sets this correctly).
  const forwarded = req.headers?.['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0] : null)?.trim()
    || req.socket?.remoteAddress
    || 'unknown';

  const result = checkRateLimit(ip, limit, windowMs);
  if (!result.allowed) {
    const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return false;
  }
  return true;
}