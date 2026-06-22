import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Exported so other modules (e.g. lib/auth.js) can run queries against the
// same connection instead of opening a second client.
export { db };

await db.execute(`
  CREATE TABLE IF NOT EXISTS logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    level     TEXT NOT NULL,
    message   TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    gameId    INTEGER NOT NULL,
    createdAt INTEGER DEFAULT (unixepoch()),
    count     INTEGER NOT NULL DEFAULT 1
  )
`);

await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_gameId ON logs(gameId)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);

// Per-workspace settings (e.g. retention) replace the old single global
// `settings` row now that an instance can host more than one account.
// Composite PK means each workspace gets its own independent value per key.
await db.execute(`
  CREATE TABLE IF NOT EXISTS workspace_settings (
    workspaceId INTEGER NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (workspaceId, key)
  )
`);

// ── Account Factory: users + workspaces ──────────────────────────────
// A user can own multiple workspaces; each workspace gets its own API
// key, so one Tracely account can keep logs separated per project (e.g.
// one workspace per Roblox game) without sharing a single global key.
// See lib/auth.js for the hashing/key-generation logic that writes here.
await db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    createdAt    INTEGER DEFAULT (unixepoch())
  )
`);

await db.execute(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    ownerUserId INTEGER NOT NULL,
    apiKeyHash  TEXT NOT NULL UNIQUE,
    apiKeyLast4 TEXT NOT NULL,
    createdAt   INTEGER DEFAULT (unixepoch())
  )
`);

await db.execute(`CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(ownerUserId)`);

// Migration: lets a just-rotated workspace keep accepting its previous key
// for a grace window, instead of cutting it off the instant rotation
// happens. Both nullable — most workspaces have never rotated, so most
// rows just carry NULL/NULL here forever. See rotateApiKey() and
// getWorkspaceByApiKey() in lib/auth.js for how these are written/read.
try {
  await db.execute(`ALTER TABLE workspaces ADD COLUMN previousApiKeyHash TEXT`);
} catch (e) {
  // Only swallow the "duplicate column" error — anything else (connection
  // failure, auth error) should still surface so it doesn't get silently
  // swallowed on every cold start while the column remains missing.
  if (!e?.message?.includes('duplicate column')) throw e;
}
try {
  await db.execute(`ALTER TABLE workspaces ADD COLUMN previousApiKeyExpiresAt INTEGER`);
} catch (e) {
  if (!e?.message?.includes('duplicate column')) throw e;
}
await db.execute(`CREATE INDEX IF NOT EXISTS idx_workspaces_prevkey ON workspaces(previousApiKeyHash)`);

// Migration: ties each log to the workspace whose API key it came in on.
// Nullable because pre-existing rows (from before accounts existed) have
// no workspace to backfill to — they'll simply stop appearing in any
// workspace-scoped query below. Safe to run every cold start: a
// duplicate-column error means it's already there.
try {
  await db.execute(`ALTER TABLE logs ADD COLUMN workspaceId INTEGER`);
} catch (e) {
  if (!e?.message?.includes('duplicate column')) throw e;
}
await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_workspaceId ON logs(workspaceId)`);

// Migration for databases created before the `count` column existed.
// Safe to run on every cold start: a duplicate-column error means it's already there.
try {
  await db.execute(`ALTER TABLE logs ADD COLUMN count INTEGER NOT NULL DEFAULT 1`);
} catch (e) {
  if (!e?.message?.includes('duplicate column')) throw e;
}

const VALID_LEVELS = new Set(['INFO', 'WARN', 'ERROR']);

// How long an identical (gameId, level, message) log can keep bumping the same
// row's counter before a new occurrence starts a fresh row instead.
const COLLAPSE_WINDOW_SECONDS = Number(process.env.COLLAPSE_WINDOW_SECONDS) || 30;

// Max log inserts accepted per gameId per 60-second window. Set to 0 to disable.
const RATE_LIMIT_PER_GAME_PER_MIN = Number(process.env.RATE_LIMIT_PER_GAME_PER_MIN) || 300;

// Window size for the rolling "error rate right now" header in getStats().
// 10 minutes is short enough to catch a fresh spike, long enough that a
// handful of stray logs don't make the rate jump around meaninglessly.
const RECENT_WINDOW_SECONDS = 600;

// Returns { inserted: true } if a row was written/updated, or
// { inserted: false, reason: 'rate_limited' } if the workspace+gameId is
// over its quota. Scoped by workspaceId+gameId together (not gameId alone)
// since gameId is just a number Roblox sends — two different accounts
// could easily pick the same one.
//
// IMPORTANT: all time windows use server-side Date.now(), NOT the
// client-supplied timestamp. The client timestamp is only used for display
// ordering — using it for rate limiting or collapse gating would let a
// Roblox game bypass both by sending a manipulated timestamp value.
export async function insertLog({ level, message, timestamp, gameId, workspaceId }) {
  const serverNow = Math.floor(Date.now() / 1000);
  const rateLimitWindowStart = serverNow - 60;             // always server time
  const collapseWindowStart  = serverNow - COLLAPSE_WINDOW_SECONDS; // always server time

  // Merge the rate-limit check and collapse-candidate fetch into one query
  // to cut sequential Turso round-trips from 3 → 2 (read pass + write pass).
  // The subquery returns the last row for this workspace+game; the outer
  // SELECT adds the rolling count alongside it so both arrive in one trip.
  //
  // IMPORTANT: both the rate-limit window and the collapse window are checked
  // against `createdAt` (server time written at insert), NOT `timestamp`
  // (client-supplied value used only for display ordering). A Roblox game
  // that sends a manipulated timestamp — e.g. far in the past to push logs
  // out of the rate-limit window, or far in the future to prevent collapsing
  // — must not be able to bypass server-side enforcement.
  const readResult = await db.execute({
    sql: `SELECT
            (SELECT COALESCE(SUM(count), 0)
               FROM logs
              WHERE workspaceId = ? AND gameId = ? AND createdAt >= ?) AS recentTotal,
            (SELECT id        FROM logs WHERE workspaceId = ? AND gameId = ? ORDER BY id DESC LIMIT 1) AS lastId,
            (SELECT level     FROM logs WHERE workspaceId = ? AND gameId = ? ORDER BY id DESC LIMIT 1) AS lastLevel,
            (SELECT message   FROM logs WHERE workspaceId = ? AND gameId = ? ORDER BY id DESC LIMIT 1) AS lastMessage,
            (SELECT createdAt FROM logs WHERE workspaceId = ? AND gameId = ? ORDER BY id DESC LIMIT 1) AS lastCreatedAt`,
    args: [
      workspaceId, gameId, rateLimitWindowStart,  // recentTotal — server-clock window
      workspaceId, gameId,                         // lastId
      workspaceId, gameId,                         // lastLevel
      workspaceId, gameId,                         // lastMessage
      workspaceId, gameId,                         // lastCreatedAt (was lastTimestamp)
    ],
  });

  const row = readResult.rows[0];

  // Rate limit: count is summed against createdAt (server clock), not the
  // client-supplied timestamp, so a manipulated timestamp can't move rows
  // outside the window to bypass the quota.
  if (RATE_LIMIT_PER_GAME_PER_MIN > 0) {
    const recentCount = Number(row.recentTotal ?? 0);
    if (recentCount >= RATE_LIMIT_PER_GAME_PER_MIN) {
      return { inserted: false, reason: 'rate_limited' };
    }
  }

  // Collapse: gate on createdAt (server time) instead of timestamp (client
  // time). Without this a game could send timestamp=0 to force every log
  // to fall outside the collapse window (preventing dedup), or send a
  // far-future timestamp to make old rows always look "within window."
  const candidate = row.lastId != null ? row : null;
  const withinWindow =
    candidate && Number(candidate.lastCreatedAt) >= collapseWindowStart;

  if (candidate && withinWindow && candidate.lastLevel === level && candidate.lastMessage === message) {
    await db.execute({
      sql: `UPDATE logs SET count = count + 1, timestamp = ? WHERE id = ?`,
      args: [timestamp, candidate.lastId],
    });
    return { inserted: true, collapsed: true };
  }

  await db.execute({
    sql: `INSERT INTO logs (level, message, timestamp, gameId, workspaceId) VALUES (?, ?, ?, ?, ?)`,
    args: [level, message, timestamp, gameId, workspaceId],
  });
  return { inserted: true, collapsed: false };
}

// Scrubs previousApiKeyHash/previousApiKeyExpiresAt off any workspace whose
// grace window has passed. Not required for correctness — getWorkspaceByApiKey
// already excludes expired rows via the expiresAt check — but there's no
// reason to leave a dead key hash sitting in the database indefinitely once
// its grace period is over. Called from the daily cleanup cron alongside log
// retention. Returns the number of workspaces scrubbed.
export async function clearExpiredPreviousApiKeys() {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: `UPDATE workspaces
          SET previousApiKeyHash = NULL, previousApiKeyExpiresAt = NULL
          WHERE previousApiKeyExpiresAt IS NOT NULL AND previousApiKeyExpiresAt <= ?`,
    args: [now],
  });
  return Number(result.rowsAffected ?? 0);
}

// Used by the cron job, which runs once per workspace with that
// workspace's own retention setting.
//
// FIX: use `createdAt` (server-written time) instead of `timestamp`
// (client-supplied value). A Roblox game that sends a far-future timestamp
// could otherwise keep rows alive past their retention window indefinitely,
// since the old WHERE clause compared against the client value. `createdAt`
// is set by the DB itself at insert time and cannot be manipulated by the client.
export async function deleteLogsOlderThan(workspaceId, days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const result = await db.execute({
    sql: `DELETE FROM logs WHERE workspaceId = ? AND createdAt < ?`,
    args: [workspaceId, cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

// Returns every workspace id, for the cron job to iterate over.
export async function getAllWorkspaceIds() {
  const result = await db.execute(`SELECT id FROM workspaces`);
  return result.rows.map((r) => Number(r.id));
}

// Deletes all logs in a workspace, or just one gameId within it when
// passed. Returns the number of rows removed.
export async function clearLogs({ workspaceId, gameId } = {}) {
  if (gameId !== undefined && gameId !== null && gameId !== '') {
    const result = await db.execute({
      sql: `DELETE FROM logs WHERE workspaceId = ? AND gameId = ?`,
      args: [Number(workspaceId), Number(gameId)],
    });
    return Number(result.rowsAffected ?? 0);
  }
  const result = await db.execute({
    sql: `DELETE FROM logs WHERE workspaceId = ?`,
    args: [Number(workspaceId)],
  });
  return Number(result.rowsAffected ?? 0);
}

const SETTINGS_DEFAULTS = {
  logRetentionDays: 30,
};
const ALLOWED_RETENTION_DAYS = new Set([1, 7, 30]);

export async function getSettings(workspaceId) {
  const rows = await db.execute({
    sql: `SELECT key, value FROM workspace_settings WHERE workspaceId = ?`,
    args: [Number(workspaceId)],
  });
  const out = { ...SETTINGS_DEFAULTS };
  for (const row of rows.rows) {
    if (row.key === 'logRetentionDays') {
      const n = Number(row.value);
      if (ALLOWED_RETENTION_DAYS.has(n)) out.logRetentionDays = n;
    }
  }
  return out;
}

// Currently the only writable setting; validated against an allow-list so a
// bad request can't push retention to something absurd (e.g. 0 or negative).
export async function setLogRetentionDays(workspaceId, days) {
  const n = Number(days);
  if (!ALLOWED_RETENTION_DAYS.has(n)) {
    throw new Error('logRetentionDays must be one of 1, 7, 30');
  }
  await db.execute({
    sql: `INSERT INTO workspace_settings (workspaceId, key, value) VALUES (?, 'logRetentionDays', ?)
          ON CONFLICT(workspaceId, key) DO UPDATE SET value = excluded.value`,
    args: [Number(workspaceId), String(n)],
  });
  return n;
}

// workspaceId is required here, not just an extra filter — it's what
// makes this an ownership check rather than a global lookup by id.
export async function getLogById(id, workspaceId) {
  const result = await db.execute({
    sql: `SELECT id, level, message, timestamp, gameId, createdAt, count
          FROM logs WHERE id = ? AND workspaceId = ?`,
    args: [Number(id), Number(workspaceId)],
  });
  return result.rows[0] ?? null;
}

export async function getLogs({ workspaceId, level, gameId, search, startTime, endTime, page = 1, limit = 50 } = {}) {
  const conditions = ['workspaceId = ?'];
  const params = [Number(workspaceId)];

  const levels = Array.isArray(level) ? level : (level ? [level] : []);
  const validLevels = levels
    .map((l) => String(l).toUpperCase())
    .filter((l) => VALID_LEVELS.has(l));

  if (validLevels.length) {
    conditions.push(`level IN (${validLevels.map(() => '?').join(', ')})`);
    params.push(...validLevels);
  }
  if (gameId !== undefined && gameId !== null && gameId !== '') {
    conditions.push('gameId = ?');
    params.push(Number(gameId));
  }
  if (startTime !== undefined && startTime !== null && startTime !== '' && Number.isFinite(Number(startTime))) {
    conditions.push('timestamp >= ?');
    params.push(Number(startTime));
  }
  if (endTime !== undefined && endTime !== null && endTime !== '' && Number.isFinite(Number(endTime))) {
    conditions.push('timestamp <= ?');
    params.push(Number(endTime));
  }
  // Free-text message search. LIKE with leading wildcard can't use the
  // message index, but logs are already filtered by workspaceId (indexed)
  // and optionally level/gameId/time, so the LIKE scan runs over a small
  // subset rather than the whole table. Caller strips and validates `search`
  // before it reaches here; we still guard against non-string values.
  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    conditions.push('message LIKE ?');
    // Escape literal % and _ so they're treated as characters, not LIKE
    // wildcards — a search for "100%" should match that string, not everything.
    const escaped = trimmedSearch.replace(/[%_\\]/g, '\\$&');
    params.push(`%${escaped}%`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  // Cap page to prevent enormous OFFSET values. OFFSET-based pagination
  // forces the DB to scan and discard (page-1)*limit rows on every query —
  // page=99999 with limit=200 would touch ~20 million rows even on an empty
  // result set. 10 000 pages × 200 rows = 2 million rows max, which is a
  // reasonable ceiling before cursor-based pagination becomes necessary.
  const safePage = Math.min(Math.max(Number(page) || 1, 1), 10_000);
  const offset = (safePage - 1) * safeLimit;

  // Run the page-of-rows query and the total-count query inside a single read
  // batch so both see the same DB snapshot. Without this, a log inserted
  // between the two SELECTs would make `total` one higher than the rows
  // actually returned — the pagination maths on the frontend would then show
  // a phantom extra page that returns empty when visited.
  const [rowsResult, totalResult] = await db.batch(
    [
      {
        sql: `SELECT id, level, message, timestamp, gameId, createdAt, count
              FROM logs ${where}
              ORDER BY timestamp DESC, id DESC
              LIMIT ? OFFSET ?`,
        args: [...params, safeLimit, offset],
      },
      {
        sql: `SELECT COALESCE(SUM(count), 0) as count FROM logs ${where}`,
        args: params,
      },
    ],
    'read',
  );

  const total = Number(totalResult.rows[0].count);

  return {
    logs: rowsResult.rows,
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(Math.ceil(total / safeLimit), 1),
  };
}

// Level counts for one fixed time range — shared by getStats()'s rolling
// error-rate window (called twice, once for "now" and once for "10
// minutes ago", to get a current value and a trend). Uses the same
// idx_logs_workspaceId / idx_logs_timestamp indexes as the rest of this
// file, so each call is one cheap indexed range scan.
async function getWindowLevelCounts(workspaceId, startInclusive, endExclusive) {
  const rows = await db.execute({
    sql: `SELECT level, COALESCE(SUM(count), 0) as count FROM logs
          WHERE workspaceId = ? AND timestamp >= ? AND timestamp < ?
          GROUP BY level`,
    args: [Number(workspaceId), startInclusive, endExclusive],
  });
  const out = { INFO: 0, WARN: 0, ERROR: 0 };
  for (const row of rows.rows) {
    if (out[row.level] !== undefined) out[row.level] = Number(row.count);
  }
  return out;
}

export async function getStats(workspaceId) {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 24 * 60 * 60;

  // All four queries are independent — run them in parallel rather than
  // sequentially. This cuts stats endpoint latency roughly in half since
  // each is an indexed range scan against the same table: there's no reason
  // to wait for one before firing the next.
  const [counts, hourly, currentWindow, previousWindow] = await Promise.all([
    db.execute({
      sql: `SELECT level, COALESCE(SUM(count), 0) as count FROM logs WHERE workspaceId = ? GROUP BY level`,
      args: [Number(workspaceId)],
    }),
    db.execute({
      sql: `SELECT
              (timestamp / 3600) * 3600 AS bucket,
              level,
              COALESCE(SUM(count), 0) AS count
            FROM logs
            WHERE workspaceId = ? AND timestamp >= ?
            GROUP BY bucket, level
            ORDER BY bucket ASC`,
      args: [Number(workspaceId), dayAgo],
    }),
    getWindowLevelCounts(workspaceId, now - RECENT_WINDOW_SECONDS, now),
    getWindowLevelCounts(workspaceId, now - RECENT_WINDOW_SECONDS * 2, now - RECENT_WINDOW_SECONDS),
  ]);

  const countMap = { INFO: 0, WARN: 0, ERROR: 0 };
  for (const row of counts.rows) {
    if (countMap[row.level] !== undefined) countMap[row.level] = Number(row.count);
  }

  const currentTotal  = currentWindow.INFO + currentWindow.WARN + currentWindow.ERROR;
  const previousTotal = previousWindow.INFO + previousWindow.WARN + previousWindow.ERROR;

  // Rolling error-rate header: "right now" (last 10 min) vs. the 10
  // minutes before that, so the dashboard can show whether things are
  // trending up or down — not just a 24-hour total that a fresh spike
  // would barely move. The 24h `hourly` data above is too coarse-grained
  // for this (1-hour buckets); this needs its own minute-scale query.
  const recent = {
    windowMinutes: RECENT_WINDOW_SECONDS / 60,
    total: currentTotal,
    errorCount: currentWindow.ERROR,
    // null (not 0) when there's no traffic in the window — 0% and "no
    // data yet" need to render differently on the dashboard.
    errorRate: currentTotal > 0 ? currentWindow.ERROR / currentTotal : null,
    previousErrorRate: previousTotal > 0 ? previousWindow.ERROR / previousTotal : null,
  };

  return {
    counts: countMap,
    hourly: hourly.rows.map((r) => ({
      bucket: Number(r.bucket),
      level: r.level,
      count: Number(r.count),
    })),
    recent,
  };
}
// ── Admin audit log ──────────────────────────────────────────────────
// Written by lib/admin-auth.js on every mutating admin action (force-delete,
// reset, etc.) so there's a tamper-evident trail of what happened and when.
// Read-only admin calls (stats, user-view) don't produce rows here — only
// actions that change production data do.
await db.execute(`
  CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    adminEmail  TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    targetType  TEXT    NOT NULL,
    targetId    TEXT,
    detail      TEXT,
    createdAt   INTEGER DEFAULT (unixepoch())
  )
`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_admin_audit_createdAt ON admin_audit_logs(createdAt DESC)`);