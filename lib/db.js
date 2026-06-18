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
    createdAt INTEGER DEFAULT (unixepoch())
  )
`);

await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_gameId ON logs(gameId)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);

const VALID_LEVELS = new Set(['INFO', 'WARN', 'ERROR']);

export async function insertLog({ level, message, timestamp, gameId }) {
  await db.execute({
    sql: `INSERT INTO logs (level, message, timestamp, gameId) VALUES (?, ?, ?, ?)`,
    args: [level, message, timestamp, gameId],
  });
}

export async function getLogs({ level, gameId, page = 1, limit = 50 } = {}) {
  const conditions = [];
  const params = [];

  if (level && VALID_LEVELS.has(String(level).toUpperCase())) {
    conditions.push('level = ?');
    params.push(String(level).toUpperCase());
  }
  if (gameId !== undefined && gameId !== null && gameId !== '') {
    conditions.push('gameId = ?');
    params.push(Number(gameId));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const rows = await db.execute({
    sql: `SELECT id, level, message, timestamp, gameId, createdAt
          FROM logs ${where}
          ORDER BY timestamp DESC
          LIMIT ? OFFSET ?`,
    args: [...params, safeLimit, offset],
  });

  const totalRow = await db.execute({
    sql: `SELECT COUNT(*) as count FROM logs ${where}`,
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
    `SELECT level, COUNT(*) as count FROM logs GROUP BY level`
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
            COUNT(*) AS count
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
