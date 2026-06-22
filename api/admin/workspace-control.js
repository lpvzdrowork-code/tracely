import { db } from '../../lib/db.js';
import { requireAdmin, writeAdminAuditLog } from '../../lib/admin-auth.js';

// ─────────────────────────────────────────
// Workspace control actions
//
// force-delete: permanently removes the workspace, all its logs, and its
//   settings. The owner account is NOT deleted — they can still log in and
//   create a new workspace. Use this when a workspace has been abused or
//   needs to be purged outside the normal retention cycle.
//
// reset-logs: deletes only the logs for a workspace, leaving the workspace
//   row, API key, and settings intact. Use this to help a user start fresh
//   without losing their key.
// ─────────────────────────────────────────

const VALID_ACTIONS = new Set(['force-delete', 'reset-logs']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { workspaceId, action, reason } = req.body || {};

  const wid = Number(workspaceId);
  if (!workspaceId || !Number.isFinite(wid)) {
    return res.status(400).json({ error: 'workspaceId is required and must be numeric' });
  }
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` });
  }

  // Confirm the workspace exists before acting — gives a clean 404 rather
  // than silently succeeding on a nonexistent ID.
  const wsResult = await db.execute({
    sql: `SELECT id, name, ownerUserId FROM workspaces WHERE id = ?`,
    args: [wid],
  });
  const ws = wsResult.rows[0];
  if (!ws) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  if (action === 'force-delete') {
    // Run all three deletes as one atomic batch — same pattern as the
    // normal deleteWorkspace(), but without the "last workspace" guard
    // (admin force-delete can leave an account workspaceless intentionally).
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

    return res.status(200).json({
      ok:     true,
      action: 'force-delete',
      workspaceId: wid,
    });
  }

  if (action === 'reset-logs') {
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

    return res.status(200).json({
      ok:      true,
      action:  'reset-logs',
      workspaceId: wid,
      deleted,
    });
  }
}