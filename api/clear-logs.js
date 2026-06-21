import { clearLogs } from '../lib/db.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workspaceId, gameId } = req.body || {};

  const ctx = await requireWorkspace(req, res, workspaceId);
  if (!ctx) return;

  if (gameId !== undefined && gameId !== null && gameId !== '' && !Number.isFinite(Number(gameId))) {
    return res.status(400).json({ error: 'gameId must be numeric' });
  }

  const deleted = await clearLogs({ workspaceId: ctx.workspace.id, gameId });
  return res.status(200).json({ deleted });
}