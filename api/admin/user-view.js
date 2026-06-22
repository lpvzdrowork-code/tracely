import { db } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin-auth.js';

// Read-only debug view of any user account.
//
// WHY NOT IMPERSONATION:
// Issuing a real session cookie for a target user would mean anyone who
// compromises this endpoint (stolen SESSION_SECRET, future auth bug, SSRF)
// instantly gets a valid 30-day session for any account on the platform.
// This endpoint gives you everything you need for debugging — workspaces,
// recent logs, settings — without that risk. Your own admin session stays
// your own; you just get a scoped read of their data.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { userId, workspaceId } = req.query;

  // ── Mode 1: list all users (no params) ──────────────────────────────
  if (!userId && !workspaceId) {
    const result = await db.execute(`
      SELECT u.id, u.email, u.createdAt,
             COUNT(w.id) AS workspaceCount
      FROM users u
      LEFT JOIN workspaces w ON w.ownerUserId = u.id
      GROUP BY u.id
      ORDER BY u.createdAt DESC
      LIMIT 200
    `);
    return res.status(200).json({
      users: result.rows.map((r) => ({
        id:             Number(r.id),
        email:          r.email,
        createdAt:      Number(r.createdAt),
        workspaceCount: Number(r.workspaceCount),
      })),
    });
  }

  // ── Mode 2: given userId, return their workspaces ────────────────────
  if (userId && !workspaceId) {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) {
      return res.status(400).json({ error: 'userId must be numeric' });
    }

    const [userResult, wsResult] = await Promise.all([
      db.execute({ sql: `SELECT id, email, createdAt FROM users WHERE id = ?`, args: [uid] }),
      db.execute({
        sql: `SELECT id, name, apiKeyLast4, createdAt FROM workspaces WHERE ownerUserId = ? ORDER BY createdAt ASC`,
        args: [uid],
      }),
    ]);

    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.status(200).json({
      user: { id: Number(user.id), email: user.email, createdAt: Number(user.createdAt) },
      workspaces: wsResult.rows.map((w) => ({
        id:          Number(w.id),
        name:        w.name,
        apiKeyLast4: w.apiKeyLast4,
        createdAt:   Number(w.createdAt),
      })),
    });
  }

  // ── Mode 3: given workspaceId, return recent logs + settings ─────────
  if (workspaceId) {
    const wid = Number(workspaceId);
    if (!Number.isFinite(wid)) {
      return res.status(400).json({ error: 'workspaceId must be numeric' });
    }

    const [wsResult, logsResult, settingsResult] = await Promise.all([
      db.execute({
        sql: `SELECT w.id, w.name, w.apiKeyLast4, w.createdAt, u.email AS ownerEmail
              FROM workspaces w JOIN users u ON u.id = w.ownerUserId
              WHERE w.id = ?`,
        args: [wid],
      }),
      db.execute({
        sql: `SELECT id, level, message, timestamp, gameId, createdAt, count
              FROM logs WHERE workspaceId = ?
              ORDER BY timestamp DESC, id DESC LIMIT 100`,
        args: [wid],
      }),
      db.execute({
        sql: `SELECT key, value FROM workspace_settings WHERE workspaceId = ?`,
        args: [wid],
      }),
    ]);

    const ws = wsResult.rows[0];
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    const settings = {};
    for (const row of settingsResult.rows) settings[row.key] = row.value;

    return res.status(200).json({
      workspace: {
        id:          Number(ws.id),
        name:        ws.name,
        apiKeyLast4: ws.apiKeyLast4,
        ownerEmail:  ws.ownerEmail,
        createdAt:   Number(ws.createdAt),
      },
      settings,
      logs: logsResult.rows.map((r) => ({
        id:        Number(r.id),
        level:     r.level,
        message:   r.message,
        timestamp: Number(r.timestamp),
        gameId:    Number(r.gameId),
        createdAt: Number(r.createdAt),
        count:     Number(r.count),
      })),
    });
  }
}