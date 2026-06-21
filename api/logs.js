import { getLogs } from '../lib/db.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workspaceId, level, gameId, page, limit, startTime, endTime } = req.query;

  const ctx = await requireWorkspace(req, res, workspaceId);
  if (!ctx) return;

  const levels = typeof level === 'string' && level.length
    ? level.split(',').map((l) => l.trim()).filter(Boolean)
    : [];

  const data = await getLogs({
    workspaceId: ctx.workspace.id,
    level: levels,
    gameId,
    startTime,
    endTime,
    page,
    limit,
  });
  return res.status(200).json(data);
}