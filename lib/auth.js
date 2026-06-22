import crypto from 'node:crypto';
import { db } from './db.js';

// ─────────────────────────────────────────
// Password hashing (Node's built-in scrypt)
//
// Using crypto.scrypt instead of an npm package like bcrypt on purpose:
// this project already migrated off better-sqlite3 because its native
// binary didn't play well with Vercel's serverless functions. scrypt is
// built into Node itself — nothing to break on a cold start — and it's
// on OWASP's accepted list for password storage. Zero new dependencies.
// (If you'd rather use bcryptjs — pure JS, no native bindings either —
// this is structured so swapping the two functions below is a small change.)
// ─────────────────────────────────────────
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // Node's default "interactive" cost, ~16MB

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  // Stored as algo$salt$hash so the cost params travel with the hash —
  // lets SCRYPT_PARAMS change later without invalidating existing accounts.
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derivedKey = await scryptAsync(password, salt, expected.length);

  // Guard the length before timingSafeEqual — it throws on a mismatch
  // instead of returning false, which would otherwise leak info via
  // "did it throw or return false" timing/branching.
  if (derivedKey.length !== expected.length) return false;
  return crypto.timingSafeEqual(derivedKey, expected);
}

// ─────────────────────────────────────────
// API keys
//
// The raw key is returned ONCE, at creation time — only its SHA-256 hash
// is ever persisted. Same model as Stripe/GitHub tokens: a DB leak doesn't
// hand out live keys. A fast hash (not a slow KDF) is correct here, unlike
// passwords — the key already has 192 bits of random entropy, so there's
// no guessing risk to slow down, and incoming requests need a quick lookup.
// ─────────────────────────────────────────
const API_KEY_PREFIX = 'tracely_live_';

// How long a rotated-out key keeps working after rotation, so a live
// Roblox game doesn't go dark the instant you click "Rotate key" — you
// get this window to push the new key before the old one is dead for
// real. Set to 0 to disable the grace period entirely (old key dies
// immediately, same as the original behavior).
const ROTATION_GRACE_MINUTES = Number(process.env.ROTATION_GRACE_MINUTES) || 60;

export function generateApiKey() {
  const secret = crypto.randomBytes(24).toString('base64url'); // 192 bits, URL-safe
  return `${API_KEY_PREFIX}${secret}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ─────────────────────────────────────────
// Users
// ─────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUser({ email, password }) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(normalizedEmail)) {
    throw new Error('Enter a valid email address');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  // Cap before hashing — scrypt on a multi-MB string would spike CPU and
  // could be used as a DoS vector against the signup endpoint.
  if (password.length > 1024) {
    throw new Error('Password must be 1024 characters or fewer');
  }

  // Hash before the existence check (not after) so a taken email and a
  // free one cost the same amount of time. Hashing here unconditionally
  // means the slow scrypt call always runs, instead of only running on
  // the free-email path — otherwise the vague error message below stops
  // a response-content enumeration attack but not a response-timing one.
  const passwordHash = await hashPassword(password);

  const existing = await db.execute({
    sql: `SELECT id FROM users WHERE email = ?`,
    args: [normalizedEmail],
  });
  if (existing.rows.length) {
    // Deliberately vague — doesn't confirm/deny via a different message
    // than other validation failures, so this endpoint can't be used to
    // enumerate which emails already have accounts.
    throw new Error('Could not create account with that email');
  }

  const result = await db.execute({
    sql: `INSERT INTO users (email, passwordHash) VALUES (?, ?)`,
    args: [normalizedEmail, passwordHash],
  });

  return { id: Number(result.lastInsertRowid), email: normalizedEmail };
}

// A syntactically valid scrypt hash with no real backing user — verified
// against on every login for an email that doesn't exist, so that path
// pays the same scrypt cost as a real user with a wrong password.
// Without this, a nonexistent email returns after one fast indexed SELECT
// while a real email takes however long scrypt takes, and that latency
// gap alone is enough to enumerate registered emails — even though the
// error message above is already deliberately identical for both cases.
const DUMMY_PASSWORD_HASH =
  `scrypt$${crypto.randomBytes(16).toString('hex')}$${crypto.randomBytes(SCRYPT_KEYLEN).toString('hex')}`;

// Returns the user (without passwordHash) on success, or null on any
// failure — wrong email and wrong password are indistinguishable to the
// caller on purpose, in both message and timing.
export async function verifyUser({ email, password }) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();

  const result = await db.execute({
    sql: `SELECT id, email, passwordHash FROM users WHERE email = ?`,
    args: [normalizedEmail],
  });
  const user = result.rows[0];

  // Always run verifyPassword, even with no matching user — hashing
  // against DUMMY_PASSWORD_HASH keeps this branch exactly as slow as the
  // real one instead of short-circuiting on a fast `if (!user) return null`.
  const valid = await verifyPassword(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
  if (!user || !valid) return null;

  return { id: user.id, email: user.email };
}

// ─────────────────────────────────────────
// Workspaces
// ─────────────────────────────────────────

// Creates a workspace owned by `ownerUserId` and mints its API key.
// Returns the raw apiKey ONCE — the caller must surface it to the user
// immediately (e.g. in the signup response), since it can't be read back
// out of the database afterward.
export async function createWorkspace({ name, ownerUserId }) {
  const workspaceName = String(name ?? '').trim();
  if (!workspaceName) {
    throw new Error('Workspace name is required');
  }
  if (!Number.isFinite(Number(ownerUserId))) {
    throw new Error('ownerUserId must be numeric');
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const apiKeyLast4 = apiKey.slice(-4);

  const result = await db.execute({
    sql: `INSERT INTO workspaces (name, ownerUserId, apiKeyHash, apiKeyLast4)
          VALUES (?, ?, ?, ?)`,
    args: [workspaceName, Number(ownerUserId), apiKeyHash, apiKeyLast4],
  });

  return {
    id: Number(result.lastInsertRowid),
    name: workspaceName,
    ownerUserId: Number(ownerUserId),
    apiKey,        // show this to the user now — it's the only time it's available in full
    apiKeyLast4,
  };
}

// ─────────────────────────────────────────
// API key cache
//
// getWorkspaceByApiKey is called on every POST /api/log — under a bursty
// Roblox spike that's hundreds of concurrent DB lookups just for auth.
// This module-level Map short-circuits those: the first request for a key
// pays the DB cost, the next N requests on the same warm function instance
// return immediately. TTL is intentionally short (5 min) so a rotated key
// falls out quickly without requiring active cache busting on every path.
//
// On Vercel serverless each function instance is single-threaded and handles
// one request at a time, so no Map locking is needed. The cache is per-
// instance — it doesn't help across a cold-start fleet, but it cuts load
// dramatically on any warm instance that handles a burst sequence.
// ─────────────────────────────────────────
const KEY_CACHE_TTL_MS  = 5 * 60 * 1000; // 5 minutes
// Upper bound on the number of entries the cache will hold. On a Vercel
// instance handling a burst from many distinct workspaces the Map would
// otherwise grow without bound — each entry is small (~200 bytes), but
// memory on serverless functions is capped and the Map is never GC'd while
// the instance stays warm. 1 000 entries × ~200 B ≈ 200 KB — well within
// budget, and more than enough for any realistic single-instance workload.
// When the cap is hit, the oldest-inserted entry is evicted first (Map
// iteration order is insertion order, so the first key is always the oldest).
const KEY_CACHE_MAX_SIZE = 1_000;
const _keyCache = new Map(); // hash → { workspace, expiresAt }

function _cacheSet(hash, workspace) {
  // Re-inserting an existing key moves it to the end of insertion order, so
  // delete first to keep the eviction order accurate for updated entries.
  _keyCache.delete(hash);
  if (_keyCache.size >= KEY_CACHE_MAX_SIZE) {
    // Evict the oldest entry — Map.keys() iterator yields insertion order.
    _keyCache.delete(_keyCache.keys().next().value);
  }
  _keyCache.set(hash, { workspace, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

function _cacheGet(hash) {
  const entry = _keyCache.get(hash);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    _keyCache.delete(hash);
    return undefined;
  }
  return entry.workspace;
}

// Called by rotateApiKey to immediately evict the old key's cache entry
// rather than waiting for the TTL to expire. Without this, requests using
// a just-rotated key would keep hitting the cache with a stale workspace
// for up to KEY_CACHE_TTL_MS even though the grace-period path in the DB
// would still accept it — the issue is the negative case: if ROTATION_GRACE_MINUTES=0,
// the old key should be dead immediately, but a cache hit would keep it alive.
function _cacheDelete(hash) {
  _keyCache.delete(hash);
}

// Looks up a workspace by a raw API key presented on an incoming request
// (e.g. a Roblox game's POST /api/log). Matches either the current key or
// a previous key still inside its post-rotation grace window — so a game
// that hasn't picked up a freshly rotated key yet doesn't immediately start
// 401ing. Returns null if it doesn't match any stored key. Cheap to call on
// every request — one indexed lookup on a hash, not a KDF, and cached in
// memory for KEY_CACHE_TTL_MS after the first hit.
export async function getWorkspaceByApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith(API_KEY_PREFIX)) {
    return null;
  }
  const hash = hashApiKey(apiKey);

  const cached = _cacheGet(hash);
  if (cached !== undefined) return cached;

  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: `SELECT id, name, ownerUserId FROM workspaces
          WHERE apiKeyHash = ?
             OR (previousApiKeyHash = ? AND previousApiKeyExpiresAt > ?)`,
    args: [hash, hash, now],
  });
  const workspace = result.rows[0] ?? null;

  // Only cache hits — a null result means an invalid/unknown key, and we
  // don't want to cache that: a key rotation in flight would then stay
  // invalid on this instance until TTL even if the DB now accepts it.
  if (workspace) _cacheSet(hash, workspace);
  return workspace;
}

// Invalidates a workspace's current API key and mints a new one in its
// place, without touching its logs, name, or settings. Same one-time-reveal
// rule as createWorkspace: the raw key is only ever in this return value —
// never persisted or readable again after this.
//
// The OLD key isn't killed outright — its hash moves into
// previousApiKeyHash with an expiry ROTATION_GRACE_MINUTES from now, so a
// live Roblox game still posting with it keeps working until that deadline
// (see getWorkspaceByApiKey, which checks both columns). Set
// ROTATION_GRACE_MINUTES=0 to go back to immediate cutoff.
//
// ownerUserId is part of the WHERE clause itself (not just a precondition
// the caller is trusted to have checked first) — same defense-in-depth
// pattern as deleteWorkspace. Returns null if workspaceId doesn't exist or
// isn't owned by ownerUserId, so the caller can 404 instead of leaking
// whether some other account's workspace id exists.
export async function rotateApiKey(workspaceId, ownerUserId) {
  const id = Number(workspaceId);
  const uid = Number(ownerUserId);

  const existing = await db.execute({
    sql: `SELECT apiKeyHash FROM workspaces WHERE id = ? AND ownerUserId = ?`,
    args: [id, uid],
  });
  const existingRow = existing.rows[0];
  if (!existingRow) return null;

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const apiKeyLast4 = apiKey.slice(-4);

  const graceExpiresAt = ROTATION_GRACE_MINUTES > 0
    ? Math.floor(Date.now() / 1000) + ROTATION_GRACE_MINUTES * 60
    : null;
  // null previousApiKeyHash when the grace period is disabled — an
  // un-expiring previous key would otherwise work forever, which is the
  // opposite of what ROTATION_GRACE_MINUTES=0 is supposed to mean.
  const previousApiKeyHash = graceExpiresAt ? existingRow.apiKeyHash : null;

  const result = await db.execute({
    sql: `UPDATE workspaces
          SET apiKeyHash = ?, apiKeyLast4 = ?,
              previousApiKeyHash = ?, previousApiKeyExpiresAt = ?
          WHERE id = ? AND ownerUserId = ?`,
    args: [apiKeyHash, apiKeyLast4, previousApiKeyHash, graceExpiresAt, id, uid],
  });

  if (Number(result.rowsAffected ?? 0) === 0) return null;

  // Evict the old key from the in-process cache immediately — don't wait
  // for TTL expiry. If ROTATION_GRACE_MINUTES=0 the old key should be dead
  // right now; a stale cache entry would keep it alive for up to
  // KEY_CACHE_TTL_MS on this instance, which defeats the immediate cutoff.
  // The new key isn't in the cache yet — it'll populate on the first use.
  _cacheDelete(existingRow.apiKeyHash);

  return { id, apiKey, apiKeyLast4, graceExpiresAt }; // apiKey shown once, same as createWorkspace
}

export async function getWorkspacesForUser(ownerUserId) {
  const result = await db.execute({
    sql: `SELECT id, name, apiKeyLast4, createdAt
          FROM workspaces WHERE ownerUserId = ?
          ORDER BY createdAt ASC`,
    args: [Number(ownerUserId)],
  });
  return result.rows;
}

// Looks up a workspace by its id and includes ownerUserId — unlike
// getWorkspacesForUser, this is meant for an authorization check (does the
// logged-in user actually own the workspaceId they're asking for?), not
// for display. apiKeyHash is still excluded.
export async function getWorkspaceById(id) {
  const result = await db.execute({
    sql: `SELECT id, name, ownerUserId, apiKeyLast4, createdAt FROM workspaces WHERE id = ?`,
    args: [Number(id)],
  });
  return result.rows[0] ?? null;
}

// Permanently deletes a workspace and everything scoped to it (its logs +
// its retention setting). All three deletes run as one atomic batch so a
// crash mid-delete can't leave orphaned logs with no parent workspace.
//
// ownerUserId is part of the WHERE clause on the workspaces delete itself
// (not just a pre-check the caller is trusted to have already done) as a
// second line of defense against deleting a workspace you don't own.
//
// The "last workspace" guard is enforced inside the DELETE itself via a
// subquery rather than as a separate SELECT → DELETE sequence. The two-step
// approach has a TOCTOU race: two concurrent requests both see count=2,
// both pass the guard, and both DELETE, leaving the account with zero
// workspaces. Folding the guard into the WHERE clause makes the check and
// the delete atomic at the DB level — the second concurrent request simply
// deletes 0 rows (the workspace is already gone) and gets a 404.
//
// Returns 'deleted' if a workspace row was removed, 'not_found' if the id
// didn't exist or didn't belong to ownerUserId, or 'last_workspace' if the
// delete was blocked because it would have been the account's only workspace.
export async function deleteWorkspace(workspaceId, ownerUserId) {
  const id = Number(workspaceId);
  const uid = Number(ownerUserId);

  const results = await db.batch(
    [
      { sql: `DELETE FROM logs WHERE workspaceId = ?`, args: [id] },
      { sql: `DELETE FROM workspace_settings WHERE workspaceId = ?`, args: [id] },
      // Only delete if ownerUserId matches AND the account still has at least
      // one other workspace. The subquery runs inside the same transaction as
      // the DELETE, so concurrent deletes can't race past this guard.
      {
        sql: `DELETE FROM workspaces
              WHERE id = ? AND ownerUserId = ?
                AND (SELECT COUNT(*) FROM workspaces WHERE ownerUserId = ?) > 1`,
        args: [id, uid, uid],
      },
    ],
    'write',
  );

  const deletedCount = Number(results[2]?.rowsAffected ?? 0);
  if (deletedCount > 0) return 'deleted';

  // Distinguish "not yours / doesn't exist" from "blocked because last workspace"
  // so the API layer can return the right status code and message.
  const check = await db.execute({
    sql: `SELECT id FROM workspaces WHERE id = ? AND ownerUserId = ?`,
    args: [id, uid],
  });
  return check.rows.length > 0 ? 'last_workspace' : 'not_found';
}