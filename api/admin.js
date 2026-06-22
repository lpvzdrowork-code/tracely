import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { requireAdmin, writeAdminAuditLog } from '../lib/admin-auth.js';
import { SESSION_COOKIE_NAME } from '../lib/session.js';

// ─────────────────────────────────────────
// Single admin endpoint — replaces api/admin/{stats,user-view,
// workspace-control,impersonate}.js so the project stays within
// Vercel Hobby's 12-function limit.
//
// Routing:
//   GET  /api/admin?action=stats
//   GET  /api/admin?action=user-view          (no extra params → list all users)
//   GET  /api/admin?action=user-view&userId=N
//   GET  /api/admin?action=user-view&workspaceId=N
//   POST /api/admin   body: { action: 'workspace-control', ... }
//   POST /api/admin   body: { action: 'impersonate', ... }
//
// Every request still passes through requireAdmin() first — the routing
// change is purely structural, the auth model is unchanged.
// ─────────────────────────────────────────

// ── Impersonation helpers (formerly api/admin/impersonate.js) ────────

const IMPERSONATION_TTL_SECONDS = 60 * 60; // 1 hour

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function createImpersonationToken(targetUser, adminEmail) {
  const payload = {
    uid:   targetUser.id,
    email: targetUser.email,
    exp:   Math.floor(Date.now() / 1000) + IMPERSONATION_TTL_SECONDS,
    imp:   adminEmail,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSecret())
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

function buildImpersonationCookie(token, req) {
  const isLocalhost = req?.headers?.host?.startsWith('localhost');
  const secureFlag  = isLocalhost ? '' : ' Secure;';
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly;${secureFlag} SameSite=Lax; Path=/; Max-Age=${IMPERSONATION_TTL_SECONDS}`;
}

// ── Route handlers ───────────────────────────────────────────────────

async function handleStats(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  const [
    userCountResult,
    workspaceCountResult,
    totalLogsResult,
    logsLast24hResult,
    activeUsersResult,
    recentAuditResult,
  ] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS count FROM users`),
    db.execute(`SELECT COUNT(*) AS count FROM workspaces`),
    db.execute(`SELECT COALESCE(SUM(count), 0) AS count FROM logs`),
    db.execute({
      sql: `SELECT level, COALESCE(SUM(count), 0) AS count
            FROM logs WHERE createdAt >= ?
            GROUP BY level`,
      args: [dayAgo],
    }),
    db.execute({
      sql: `SELECT COUNT(DISTINCT w.ownerUserId) AS count
            FROM workspaces w
            WHERE EXISTS (
              SELECT 1 FROM logs l
              WHERE l.workspaceId = w.id AND l.createdAt >= ?
            )`,
      args: [dayAgo],
    }),
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

async function handleUserView(req, res) {
  const { userId, workspaceId } = req.query;

  // Mode 1: list all users
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

  // Mode 2: user's workspaces
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

  // Mode 3: workspace logs + settings
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

const VALID_WS_ACTIONS = new Set(['force-delete', 'reset-logs']);

async function handleWorkspaceControl(req, res, ctx) {
  const { workspaceId, wsAction, reason } = req.body || {};

  const wid = Number(workspaceId);
  if (!workspaceId || !Number.isFinite(wid)) {
    return res.status(400).json({ error: 'workspaceId is required and must be numeric' });
  }
  if (!VALID_WS_ACTIONS.has(wsAction)) {
    return res.status(400).json({ error: `wsAction must be one of: ${[...VALID_WS_ACTIONS].join(', ')}` });
  }

  const wsResult = await db.execute({
    sql: `SELECT id, name, ownerUserId FROM workspaces WHERE id = ?`,
    args: [wid],
  });
  const ws = wsResult.rows[0];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  if (wsAction === 'force-delete') {
    await db.batch(
      [
        { sql: `DELETE FROM logs WHERE workspaceId = ?`,               args: [wid] },
        { sql: `DELETE FROM workspace_settings WHERE workspaceId = ?`, args: [wid] },
        { sql: `DELETE FROM workspaces WHERE id = ?`,                  args: [wid] },
      ],
      'write',
    );
    await writeAdminAuditLog({
      adminEmail: ctx.user.email,
      action:     'force-delete',
      targetType: 'workspace',
      targetId:   String(wid),
      detail:     reason
        ? `name="${ws.name}" ownerUserId=${ws.ownerUserId} reason="${reason}"`
        : `name="${ws.name}" ownerUserId=${ws.ownerUserId}`,
    });
    return res.status(200).json({ ok: true, action: 'force-delete', workspaceId: wid });
  }

  if (wsAction === 'reset-logs') {
    const result = await db.execute({
      sql: `DELETE FROM logs WHERE workspaceId = ?`,
      args: [wid],
    });
    const deleted = Number(result.rowsAffected ?? 0);
    await writeAdminAuditLog({
      adminEmail: ctx.user.email,
      action:     'reset-logs',
      targetType: 'workspace',
      targetId:   String(wid),
      detail:     reason
        ? `name="${ws.name}" deletedRows=${deleted} reason="${reason}"`
        : `name="${ws.name}" deletedRows=${deleted}`,
    });
    return res.status(200).json({ ok: true, action: 'reset-logs', workspaceId: wid, deleted });
  }
}

async function handleImpersonate(req, res, ctx) {
  const { targetUserId } = req.body || {};
  const uid = Number(targetUserId);
  if (!targetUserId || !Number.isFinite(uid)) {
    return res.status(400).json({ error: 'targetUserId is required and must be numeric' });
  }
  if (Number(ctx.user.id) === uid) {
    return res.status(400).json({ error: 'Cannot impersonate your own account' });
  }

  const result = await db.execute({
    sql: `SELECT id, email FROM users WHERE id = ?`,
    args: [uid],
  });
  const targetUser = result.rows[0];
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  let token;
  try {
    token = createImpersonationToken(
      { id: Number(targetUser.id), email: targetUser.email },
      ctx.user.email,
    );
  } catch (err) {
    return res.status(500).json({ error: `Token generation failed: ${err.message}` });
  }

  await writeAdminAuditLog({
    adminEmail: ctx.user.email,
    action:     'impersonate-start',
    targetType: 'user',
    targetId:   String(uid),
    detail:     `targetEmail="${targetUser.email}" ttl=${IMPERSONATION_TTL_SECONDS}s`,
  });

  res.setHeader('Set-Cookie', buildImpersonationCookie(token, req));
  return res.status(200).json({
    ok:            true,
    targetUserId:  uid,
    targetEmail:   targetUser.email,
    expiresInSecs: IMPERSONATION_TTL_SECONDS,
    note: 'Your admin session has been replaced. Log in again as yourself after this session expires or when done.',
  });
}

// ── Main handler ─────────────────────────────────────────────────────

export default async function handler(req, res) {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const action = req.method === 'GET' ? req.query.action : (req.body || {}).action;

  if (req.method === 'GET') {
    if (action === 'stats')     return handleStats(req, res);
    if (action === 'user-view') return handleUserView(req, res);
    return res.status(400).json({ error: 'Missing or unknown action' });
  }

  if (req.method === 'POST') {
    if (action === 'workspace-control') return handleWorkspaceControl(req, res, ctx);
    if (action === 'impersonate')       return handleImpersonate(req, res, ctx);
    return res.status(400).json({ error: 'Missing or unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}