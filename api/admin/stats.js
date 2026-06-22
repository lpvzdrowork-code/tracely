import { db } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  res.setHeader('Cache-Control', 'no-store');

  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  // All queries are independent — run in parallel.
  const [
    userCountResult,
    workspaceCountResult,
    totalLogsResult,
    logsLast24hResult,
    activeUsersResult,
    recentAuditResult,
  ] = await Promise.all([
    // Total registered users
    db.execute(`SELECT COUNT(*) AS count FROM users`),

    // Total workspaces
    db.execute(`SELECT COUNT(*) AS count FROM workspaces`),

    // Total log rows (sum of count column, which deduplicates collapsed rows)
    db.execute(`SELECT COALESCE(SUM(count), 0) AS count FROM logs`),

    // Log volume in the last 24h, broken down by level
    db.execute({
      sql: `SELECT level, COALESCE(SUM(count), 0) AS count
            FROM logs WHERE createdAt >= ?
            GROUP BY level`,
      args: [dayAgo],
    }),

    // "Active" = users whose workspace received at least one log in the last 24h
    db.execute({
      sql: `SELECT COUNT(DISTINCT w.ownerUserId) AS count
            FROM workspaces w
            WHERE EXISTS (
              SELECT 1 FROM logs l
              WHERE l.workspaceId = w.id AND l.createdAt >= ?
            )`,
      args: [dayAgo],
    }),

    // Last 20 admin audit log entries for the activity feed
    db.execute(`
      SELECT id, adminEmail, action, targetType, targetId, detail, createdAt
      FROM admin_audit_logs
      ORDER BY createdAt DESC
      LIMIT 20
    `),
  ]);

  const last24h = { INFO: 0, WARN: 0, ERROR: 0, total: 0 };
  for (const row of logsLast24hResult.rows) {
    const n = Number(row.count);
    if (row.level === 'INFO' || row.level === 'WARN' || row.level === 'ERROR') {
      last24h[row.level] = n;
    }
    last24h.total += n;
  }

  return res.status(200).json({
    users:      Number(userCountResult.rows[0].count),
    workspaces: Number(workspaceCountResult.rows[0].count),
    totalLogs:  Number(totalLogsResult.rows[0].count),
    last24h,
    activeUsersLast24h: Number(activeUsersResult.rows[0].count),
    recentAudit: recentAuditResult.rows.map((r) => ({
      id:         Number(r.id),
      adminEmail: r.adminEmail,
      action:     r.action,
      targetType: r.targetType,
      targetId:   r.targetId,
      detail:     r.detail,
      createdAt:  Number(r.createdAt),
    })),
  });
}