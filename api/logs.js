import { getLogs, clearLogs } from '../lib/db.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  // GET /api/logs — fetch paginated logs
  if (req.method === 'GET') {
    const { workspaceId, level, gameId, search, page, limit, startTime, endTime } = req.query;

    const ctx = await requireWorkspace(req, res, workspaceId);
    if (!ctx) return;

    const levels = typeof level === 'string' && level.length
      ? level.split(',').map((l) => l.trim()).filter(Boolean)
      : [];

    const data = await getLogs({
      workspaceId: ctx.workspace.id,
      level: levels,
      gameId,
      search,
      startTime,
      endTime,
      page,
      limit,
    });
    return res.status(200).json(data);
  }

  // POST /api/logs — clear logs (formerly /api/clear-logs)
  if (req.method === 'POST') {
    const { workspaceId, gameId } = req.body || {};

    const ctx = await requireWorkspace(req, res, workspaceId);
    if (!ctx) return;

    if (gameId !== undefined && gameId !== null && gameId !== '' && !Number.isFinite(Number(gameId))) {
      return res.status(400).json({ error: 'gameId must be numeric' });
    }

    const deleted = await clearLogs({ workspaceId: ctx.workspace.id, gameId });
    return res.status(200).json({ deleted });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}