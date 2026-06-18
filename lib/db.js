import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

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

// Migration for databases created before the `count` column existed.
// Safe to run on every cold start: a duplicate-column error means it's already there.
try {
  await db.execute(`ALTER TABLE logs ADD COLUMN count INTEGER NOT NULL DEFAULT 1`);
} catch {
  // column already exists, ignore
}

const VALID_LEVELS = new Set(['INFO', 'WARN', 'ERROR']);

// How long an identical (gameId, level, message) log can keep bumping the same
// row's counter before a new occurrence starts a fresh row instead.
const COLLAPSE_WINDOW_SECONDS = Number(process.env.COLLAPSE_WINDOW_SECONDS) || 30;

// Max log inserts accepted per gameId per 60-second window. Set to 0 to disable.
const RATE_LIMIT_PER_GAME_PER_MIN = Number(process.env.RATE_LIMIT_PER_GAME_PER_MIN) || 300;

// Returns { inserted: true } if a row was written/updated, or
// { inserted: false, reason: 'rate_limited' } if the gameId is over its quota.
export async function insertLog({ level, message, timestamp, gameId }) {
  if (RATE_LIMIT_PER_GAME_PER_MIN > 0) {
    const windowStart = timestamp - 60;
    const recent = await db.execute({
      sql: `SELECT COALESCE(SUM(count), 0) as total FROM logs WHERE gameId = ? AND timestamp >= ?`,
      args: [gameId, windowStart],
    });
    const recentCount = Number(recent.rows[0].total);
    if (recentCount >= RATE_LIMIT_PER_GAME_PER_MIN) {
      return { inserted: false, reason: 'rate_limited' };
    }
  }

  // Try to collapse into the most recent row from the same game if it's an
  // identical level+message within the collapse window, rather than growing
  // the table for a script stuck spamming the same line every frame.
  const last = await db.execute({
    sql: `SELECT id, level, message, timestamp FROM logs
          WHERE gameId = ?
          ORDER BY id DESC
          LIMIT 1`,
    args: [gameId],
  });

  const candidate = last.rows[0];
  const withinWindow =
    candidate && Math.abs(timestamp - Number(candidate.timestamp)) <= COLLAPSE_WINDOW_SECONDS;

  if (candidate && withinWindow && candidate.level === level && candidate.message === message) {
    await db.execute({
      sql: `UPDATE logs SET count = count + 1, timestamp = ? WHERE id = ?`,
      args: [timestamp, candidate.id],
    });
    return { inserted: true, collapsed: true };
  }

  await db.execute({
    sql: `INSERT INTO logs (level, message, timestamp, gameId) VALUES (?, ?, ?, ?)`,
    args: [level, message, timestamp, gameId],
  });
  return { inserted: true, collapsed: false };
}

export async function deleteLogsOlderThan(days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const result = await db.execute({
    sql: `DELETE FROM logs WHERE timestamp < ?`,
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

export async function getLogs({ level, gameId, startTime, endTime, page = 1, limit = 50 } = {}) {
  const conditions = [];
  const params = [];

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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const rows = await db.execute({
    sql: `SELECT id, level, message, timestamp, gameId, createdAt, count
          FROM logs ${where}
          ORDER BY timestamp DESC, id DESC
          LIMIT ? OFFSET ?`,
    args: [...params, safeLimit, offset],
  });

  const totalRow = await db.execute({
    sql: `SELECT COALESCE(SUM(count), 0) as count FROM logs ${where}`,
    args: params,
  });

  const total = Number(totalRow.rows[0].count);

  return {
    logs: rows.rows,
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(Math.ceil(total / safeLimit), 1),
  };
}

export async function getStats() {
  const counts = await db.execute(
    `SELECT level, COALESCE(SUM(count), 0) as count FROM logs GROUP BY level`
  );

  const countMap = { INFO: 0, WARN: 0, ERROR: 0 };
  for (const row of counts.rows) {
    if (countMap[row.level] !== undefined) countMap[row.level] = Number(row.count);
  }

  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const hourly = await db.execute({
    sql: `SELECT
            (timestamp / 3600) * 3600 AS bucket,
            level,
            COALESCE(SUM(count), 0) AS count
          FROM logs
          WHERE timestamp >= ?
          GROUP BY bucket, level
          ORDER BY bucket ASC`,
    args: [dayAgo],
  });

  return {
    counts: countMap,
    hourly: hourly.rows.map((r) => ({
      bucket: Number(r.bucket),
      level: r.level,
      count: Number(r.count),
    })),
  };
}