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

// Looks up a workspace by a raw API key presented on an incoming request
// (e.g. a Roblox game's POST /api/log). Matches either the current key or
// a previous key still inside its post-rotation grace window — so a game
// that hasn't picked up a freshly rotated key yet doesn't immediately start
// 401ing. Returns null if it doesn't match any stored key. Cheap to call on
// every request — one indexed lookup on a hash, not a KDF.
export async function getWorkspaceByApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith(API_KEY_PREFIX)) {
    return null;
  }
  const hash = hashApiKey(apiKey);
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: `SELECT id, name, ownerUserId FROM workspaces
          WHERE apiKeyHash = ?
             OR (previousApiKeyHash = ? AND previousApiKeyExpiresAt > ?)`,
    args: [hash, hash, now],
  });
  return result.rows[0] ?? null;
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
// Returns true if a workspace row was actually deleted, false if the id
// didn't exist or didn't belong to ownerUserId — callers use this to
// decide between a 204 and a 404.
export async function deleteWorkspace(workspaceId, ownerUserId) {
  const id = Number(workspaceId);
  const uid = Number(ownerUserId);

  const results = await db.batch(
    [
      { sql: `DELETE FROM logs WHERE workspaceId = ?`, args: [id] },
      { sql: `DELETE FROM workspace_settings WHERE workspaceId = ?`, args: [id] },
      { sql: `DELETE FROM workspaces WHERE id = ? AND ownerUserId = ?`, args: [id, uid] },
    ],
    'write',
  );

  return Number(results[2]?.rowsAffected ?? 0) > 0;
}